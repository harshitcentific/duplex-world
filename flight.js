/* ===========================================================================
   Duplex World - scroll-scrubbed camera flight, rendered live from stills.
   ---------------------------------------------------------------------------
   Same mechanic as the scroll-world skill: scroll drives a camera, not a
   slideshow. The difference is where the camera comes from. The skill
   pre-renders the flight as AI video and the page scrubs currentTime; here the
   flight is COMPUTED, every frame, as a transform over the supplied diorama.

   Why that is worth doing, beyond costing nothing:

     - Seams cannot pop. In the video pipeline a seam is two separately rendered
       clips that have to agree pixel for pixel, which is the single failure the
       skill spends the most words on. Here there are no clips, so there is no
       seam - one continuous function of scroll position.
     - Scrubbing backwards is exact, not a decoder seek.
     - The whole page is ~600 KB, so it still fits the single-file export the
       rest of this deck ships as.

   The trade is that the camera can only move within a flat image: it dollies and
   pans, it cannot orbit or open a roof. So the backdrop deliberately softens and
   dims as it pushes in, and the sharp object at each stop is that domain's own
   globe, at its native size.

   CONFIG - deliberately the scroll-world shape, so a rendered video chain can be
   dropped in later without rewriting the page:

     mountFlight(container, {
       hero: { src, w, h },
       sections: [{ id, label, still, clip?, eyebrow, title, body, tags[],
                    accent, scroll, linger, cam:{x,y,z}, cta?, note? }],
     })

   `cam` is in fractions of the hero image, so the numbers come straight off
   make_assets.py's measured label pills rather than being eyeballed. `clip` is
   read but unused today; when present a future build plays it instead of
   computing the transform.
   ========================================================================= */

function mountFlight(root, config) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const S = config.sections || [];
  const N = S.length;
  const HERO = config.hero;
  const ASPECT = HERO.w / HERO.h;

  // Which BACKDROP a section wants on the left. Two of them, because a page about a paper
  // opens on the paper rather than on a camera move.
  //
  // A section's `mark` is a separate thing and composes with either: it is a name plate
  // over the backdrop, not a replacement for it. That distinction is the whole reason the
  // six world stops can keep flying - the film visits each world in turn and the plate says
  // which one you are looking at, where before the plate REPLACED the film and the flight
  // stopped dead for six stops.
  const STAGE_ROLES = ['logo', 'film', 'art', 'none'];
  const roleOf = (s) => (STAGE_ROLES.indexOf(s.stage) >= 0 ? s.stage
                         : (config.video ? 'film' : 'logo'));

  // ---------------------------------------------------------------- DOM
  const SHELL = config.shell || 'stacked';
  root.innerHTML = '';
  root.className = 'fw fw-shell-' + SHELL;

  // This page is committed to a single light world - the film is shot on a white studio
  // floor - and the walk renderer decides its own theme by reading this attribute at build
  // time. Set here rather than in the markup because the single-file export and the
  // artifact host both supply their own <html>, so an attribute written on the source tag
  // is silently dropped and every map comes up in the dark theme against a light page.
  document.documentElement.dataset.theme = 'light';
  // Art referenced from the markup rather than from this config - the topbar mark - still
  // has to be resolved through the export's table.
  document.querySelectorAll('img[data-art]').forEach((im) => {
    const [real, packed] = artSrc('art:' + im.dataset.art);
    if (packed) im.dataset.fallback = packed;
    if (real) im.src = real;
  });
  try {
    // The demo page at the site root writes this key, and the renderer prefers it over the
    // document. A reader who switched that page to dark would otherwise carry it here.
    if (localStorage.getItem('duplexworld-theme') === 'dark') {
      localStorage.setItem('duplexworld-theme', 'light');
    }
  } catch (e) { /* storage blocked; the attribute above still governs */ }

  const stage = el('div', 'fw-stage');
  const sky = el('div', 'fw-sky');
  const heroImg = artImg(null, null, 'fw-hero');
  // alt is assigned with src, never before it. An <img> with alt and no src is still an
  // image to assistive technology and Firefox paints the alt text across the stage, which
  // in the video path is a whole 38 MB download's worth of a sentence on screen.
  const HERO_ALT = 'The Duplex World diorama: the six worlds of an ordinary day, connected by paths';
  // Deferred when there is a film: this is 355 KB over the wire and 6.1 MB decoded, and in
  // the video path it is hidden the moment the first frame lands. Loading it anyway just
  // takes bandwidth from the film during the one window where the band is still empty.
  // Keyed off the VALIDATED config, not the raw one. `VID` is null both when there is no
  // video and when the config was rejected, and in the rejected case no <video> is ever
  // created - so the error handler that loads this backdrop could never fire and the left
  // half of the page stayed empty for the whole flight, with only a console warning.
  // Assigned below, once VID exists. `let` rather than a direct initialiser because the
  // value depends on the VALIDATED video config, which is built further down.
  let heroWanted;
  function setHeroSrc() {
    heroImg.alt = HERO_ALT;
    const [real, packed] = artSrc(HERO.src);
    heroImg.dataset.fallback = packed || real.replace(/\.webp$/i, '.png');
    heroImg.src = real;
  }
  function loadHero() {
    if (heroWanted) return;
    heroWanted = true;
    heroImg.hidden = false;
    setHeroSrc();
    heroImg.addEventListener('load', layout);
  }

  // The rendered chain, when there is one. Scroll drives currentTime rather than a
  // transform, so the "camera" is whatever Seedance actually filmed. Everything else on
  // the page - bands, copy, rail - is unchanged, because it all keys off scroll position
  // and never cared how the backdrop was produced.
  // The guard checks the shape AND the values. A single non-finite entry makes timeAt
  // return NaN, drawVideo bails, and the film silently freezes on its last good frame while
  // the copy keeps painting - a failure with no console output and no visible cause. A
  // non-monotonic list is just as quiet: it plays one leg backwards.
  // `null` is now a legal entry and means "this section is not filmed". It is not the same
  // as zero: zero is the first frame and would drag the chain back to the top of the clip.
  function videoOK_config(v) {
    if (!v || typeof v.src !== 'string' || !Array.isArray(v.stops)) return 'video.src and video.stops are required';
    if (v.stops.length !== S.length) return 'video.stops needs exactly one entry per section';
    const filmed = v.stops.map((t, i) => [t, i]).filter(([t]) => t !== null && t !== undefined);
    if (filmed.length < 2) return 'video.stops needs at least two filmed sections; use null for the rest';
    if (!filmed.every(([t]) => Number.isFinite(t) && t >= 0)) return 'every non-null video.stops entry must be a finite, non-negative number';
    for (let k = 1; k < filmed.length; k++) {
      if (filmed[k][0] < filmed[k - 1][0]) return 'video.stops must not decrease; the leg from section ' + filmed[k - 1][1] + ' to ' + filmed[k][1] + ' would play backwards';
    }
    // A section that asks for the film but was never given a time would seek to NaN and
    // freeze the chain silently on whatever frame happened to be up.
    const orphan = S.findIndex((s, i) => roleOf(s) === 'film' &&
                                         (v.stops[i] === null || v.stops[i] === undefined));
    if (orphan >= 0) return 'section ' + orphan + ' has stage:"film" but no video.stops entry';
    return null;
  }
  const vidWhy = config.video ? videoOK_config(config.video) : 'no video configured';
  const VID = (config.video && !vidWhy) ? config.video : null;
  if (config.video && vidWhy) {
    console.warn('flight: ' + vidWhy + '; falling back to the computed camera');
  }
  // Now that VID is known. A rejected config leaves VID null and creates no <video>, so
  // the error handler that would otherwise load this backdrop can never fire - keyed off
  // the raw `config.video` instead, the left half of the page stayed empty for the whole
  // flight with nothing but a console warning to say why.
  heroWanted = !VID;
  // With a film on the page the hero still is never shown, and an <img> carrying no src is
  // a broken image to the document: naturalWidth 0, which is what the export's own asset
  // check flags. Taken out of the tree rather than merely hidden.
  if (heroWanted) { setHeroSrc(); } else { heroImg.hidden = true; }
  let videoOK = false;
  let blobURL = null;
  const videoEl = VID ? document.createElement('video') : null;
  if (videoEl) {
    videoEl.className = 'fw-video';
    // Fetched whole and handed over as a Blob rather than pointed at the URL.
    //
    // This is what makes scrubbing BACKWARDS work. A streamed <video> is scrubbed by range
    // request: forward seeks ride the read-ahead the decoder already has, but once the file
    // has played out to the end the early ranges are evicted from the media cache, so every
    // backward seek goes to the network. Measured on this file that is the whole of the
    // "it does not come back the way it went" complaint - the maths was never wrong, the
    // bytes were simply not there any more. From a Blob every seek is memory in both
    // directions. serve.py's own comment records the same failure from the server side.
    //
    // The wait costs nothing visible: the computed camera flies the page until `loadeddata`
    // lands, which is the arrangement the page already had.
    fetch(VID.src)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((b) => { blobURL = URL.createObjectURL(b); videoEl.src = blobURL; })
      .catch(() => { videoEl.src = VID.src; });   // streamed is worse than absent, but not by much
    videoEl.muted = true;
    videoEl.defaultMuted = true;
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    if (VID.poster) videoEl.poster = artSrc(VID.poster)[0];
    videoEl.setAttribute('aria-hidden', 'true');
    // Never autoplay: this is a scrub surface, not a film. Playing it would fight
    // every currentTime write.
    videoEl.addEventListener('loadeddata', () => {
      videoOK = true;
      // Only now retire the computed-camera backdrop. If the video never decodes the
      // class never lands and the page keeps working exactly as it did before.
      root.classList.add('fw-has-video');
      onScroll();
    });
    videoEl.addEventListener('seeked', () => {
      seekBusy = false;
      // A new frame is up, so the last ground sample describes a frame nobody is looking at.
      // Without this the sampler is purely time-throttled, and the throttle loses a race it
      // is guaranteed to enter: the frame settles, the camera stops moving, the eased colour
      // has already reached the OLD sample so nothing reports movement, and the rAF chain
      // parks before the 90ms is up. Measured: stop 4 held stop 3's floor, rgb(229,230,229)
      // against a frame whose floor is rgb(252,250,250).
      groundDirty = true;
      if (seekQueued !== null) {
        const q = seekQueued;
        seekQueued = null;
        seekBusy = true;
        try { videoEl.currentTime = q; } catch (e) { seekBusy = false; }
      }
      // The follow loop may have parked itself while a seek was outstanding.
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; frame(false); });
    });
    videoEl.addEventListener('error', () => {
      videoOK = false;
      root.classList.remove('fw-has-video');
      // Retire the element outright. Leaving it displayed would keep a dead poster over the
      // fallback camera, and a seek that was in flight when the decoder died never fires
      // `seeked`, so the coalescing latch has to be released by hand or it deadlocks.
      root.classList.add('fw-video-dead');
      seekBusy = false;
      seekQueued = null;
      // The Blob is tens of megabytes and nothing will read it again. Without this the
      // browser holds it for the life of the document.
      if (blobURL) { URL.revokeObjectURL(blobURL); blobURL = null; }
      loadHero();         // only now is the fallback image actually needed
      frame(true);        // snap the camera into place rather than swooping to it
    });
  }

  const veil = el('div', 'fw-veil');
  // The copy has to stay readable over whatever happens to be under it, and what is
  // under it changes every frame. A scrim on the copy side is the only reliable fix:
  // text shadows alone lose against a white clinic wall.
  const scrim = el('div', 'fw-scrim');
  // The hero still is only in the tree when it is the thing being shown. With a film on
  // the page it never is, and an <img> with no src reports naturalWidth 0, which is a
  // broken image to any checker that walks document.images.
  stage.append(sky, veil, scrim);
  if (heroWanted) stage.insertBefore(heroImg, veil);
  if (videoEl) stage.insertBefore(videoEl, veil);

  // ------------------------------------------------------------ the other stage layers
  // The mark. It opens small above the title, then grows and takes the left half as the
  // page turns into two columns - which is why it is a stage layer and not an <img> inside
  // the copy: an image in the flow cannot travel out of the flow. Its whole geometry is one
  // scroll-driven number, --logo-t, so the shells can each decide where it lands.
  const LOGO = config.logo || {};
  const logoWrap = el('div', 'fw-logo');
  const logoImg = artImg(LOGO.src || HERO.src,
                         LOGO.alt || 'The Duplex World mark: the six worlds under one dome',
                         'fw-logo-img');
  logoWrap.appendChild(logoImg);
  logoWrap.hidden = true;
  stage.appendChild(logoWrap);

  // The world names, for the stops whose evidence is a table. A name and one line, because
  // six paragraphs about six worlds is the writeup this page is explicitly not doing.
  //
  // ONE LAYER PER SECTION, not one shared layer whose text is rewritten on arrival. Shared,
  // the six consecutive world stops kept the layer at full opacity the whole way through
  // (each stop's fade overlapped the next), so the only thing that ever changed was the
  // text, and it changed in a single frame at the midpoint between two stops. That is a cut
  // in the middle of a page whose entire premise is that it does not cut. Per section they
  // cross-fade on their own curves, exactly as the copy panels opposite them already do.
  // A per-section still, shown in the film's own box. The audio section has its own
  // artwork - the walker in headphones, pointing at the samples beside him - and it is a
  // picture rather than a frame of the flight, so it gets a layer instead of a stop time.
  const artImgs = S.map((sec) => {
    if (!sec.art) return null;
    // A clip is allowed here, not only a still. The audio section's art is the walker
    // turning to face the reader, which is a motion, and freezing the left half for one
    // stop in the middle of a page built on continuous movement reads as a fault.
    // Muted, inline and looping, so it is decoration rather than media: no controls, no
    // sound, and nothing for the reader to operate.
    if (/\.(mp4|webm)$/i.test(sec.art)) {
      const v = document.createElement('video');
      v.className = 'fw-art is-clip';
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
      v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      v.preload = 'auto';
      v.src = artSrc(sec.art)[0] || sec.art;
      v.hidden = true;
      stage.appendChild(v);
      return v;
    }
    const im = artImg(sec.art, sec.artAlt || '', 'fw-art');
    im.hidden = true;
    stage.appendChild(im);
    return im;
  });

  const marks = S.map((s) => {
    if (!s.mark) return null;
    const w = el('div', 'fw-mark');
    w.style.setProperty('--accent', s.accent || '#b8125a');
    // Only when there is one. An <img> with no src is still an image to the document: it
    // reports naturalWidth 0, which is indistinguishable from art that failed to decode,
    // and it is what the alt-text-across-the-stage guard elsewhere in this file exists to
    // avoid. The world plates carry no globe - the film is already showing that world.
    const im = s.mark.src ? artImg(s.mark.src, '', 'fw-mark-globe') : null;
    const nm = el('div', 'fw-mark-name');
    nm.textContent = s.mark.name || '';
    const ln = el('div', 'fw-mark-line');
    ln.textContent = s.mark.line || '';
    if (im) w.appendChild(im);
    w.append(nm, ln);
    w.hidden = true;
    stage.appendChild(w);
    return w;
  });

  // One floating globe per section that has one. Kept in the DOM the whole time
  // and driven by opacity/transform, so nothing ever has to load mid-flight.
  const tiles = S.map((s) => {
    if (!s.still) return null;
    const im = new Image();
    im.src = s.still;
    im.alt = s.label + ' world globe';
    im.className = 'fw-tile';
    im.decoding = 'async';
    stage.appendChild(im);
    return im;
  });

  // Filled by the `maps` block below as the panels are built, and read by the lifecycle at
  // the bottom of this function. Declared here because a panel is built before the code that
  // manages it exists.
  const mapStops = [];
  const runStops = [];

  const copyWrap = el('div', 'fw-copy');
  // Scrolling swaps the live panel with no other signal, so announce it - but announce the
  // STOP, not the panel. A live region wrapped around all five articles turns one scroll to
  // the bottom into five queued readings of a title, two 60-word columns, six evidence cards
  // and a five-row table, and `polite` queues rather than interrupts, so the speech ends up
  // minutes behind the reader with no way to stop it.
  const status = el('div', 'fw-sr');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const panels = S.map((s, i) => {
    const p = el('article', 'fw-panel' + (s.layout === 'hero' ? ' fw-panel-hero' : ''));
    if (s.id) p.id = s.id;
    p.style.setProperty('--accent', s.accent || '#d61a63');
    const eyebrow = el('div', 'fw-eyebrow');
    eyebrow.textContent = s.eyebrow || '';
    // A world stop's heading is its name plate, which lives on the other half of the
    // screen; without this, five results blocks shipped an empty <h2> and had no heading at
    // all in the accessibility tree.
    const h = el(s.layout === 'hero' && i === 0 ? 'h1' : 'h2', 'fw-title');
    h.textContent = s.title || (s.mark && s.mark.name) || '';
    if (!s.title && s.mark && s.mark.name) h.classList.add('fw-sr');
    const body = el('p', 'fw-body');
    body.textContent = s.body || '';
    p.append(eyebrow, h, body);
    if (!s.body) body.remove();

    /* The opening summary: the abstract, and the three figures it is claiming.
       ---------------------------------------------------------------------------
       One screen that says what the work is AND shows the evidence for the one sentence
       that matters - "even the best voice agents leave substantial room for improvement on
       all 3 axes". Those three numbers are three different systems, so a reader who is only
       ever going to look at one screen should see all three plotted.

       The abstract is written as a list of runs rather than a string, because three of those
       runs are LINKED to a plot: hovering either one tints both. That is the whole reason
       the numbers are worth repeating in the prose - the prose says the claim, the plot
       shows the spread behind it, and the tint says they are the same fact.

       Deliberately no captions, no axis titles, no notes. The tile's own heading is the
       metric and the bars carry their values. */
    if (s.summary) {
      const SM = s.summary;
      const wrap = el('div', 'fw-sum');

      if (SM.abstract) {
        const ab = el('div', 'fw-sum-abstract');
        SM.abstract.forEach((run) => {
          if (typeof run === 'string') {
            ab.appendChild(document.createTextNode(run));
            return;
          }
          const sp = el('span', 'fw-lnk');
          sp.textContent = run.t;
          sp.dataset.link = run.link;
          sp.tabIndex = 0;
          ab.appendChild(sp);
        });
        wrap.appendChild(ab);
      }

      // Simple tiles: a heading and a few lines. They sit in the matrix beside the plots.
      const holeAfter = SM.holeAfter === undefined ? 2 : SM.holeAfter;
      // The mark sits IN the middle cell as its own image rather than being the stage film
      // showing through a hole. Flying the film from that cell out to the left column at the
      // next stop was a move nobody asked the page to make: the matrix should simply scroll
      // away, and the flight should begin where the flight begins.
      const mkHole = () => {
        const hole = el('div', 'fw-sum-hole');
        if (SM.mark) hole.appendChild(artImg(SM.mark, '', 'fw-sum-mark'));
        if (SM.centre) {
          const hl = el('span', '');
          hl.textContent = SM.centre;
          hole.appendChild(hl);
        }
        wrap.appendChild(hole);
      };
      (SM.tiles || []).forEach((T, ti) => {
        if (ti === holeAfter) mkHole();
        const t = el('figure', 'fw-tile-plot is-note');
        const h = el('figcaption', 'fw-tile-h');
        h.textContent = T.label;
        t.appendChild(h);
        if (T.big) {
          const b = el('div', 'fw-tile-big');
          b.textContent = T.big;
          t.appendChild(b);
        }
        if (T.worlds) {
          const g = el('div', 'fw-tile-worlds');
          T.worlds.forEach(([nm, src]) => {
            const w = el('div', 'fw-tw');
            w.appendChild(artImg(src, '', 'fw-tw-img'));
            const l = el('span', '');
            l.textContent = nm;
            w.appendChild(l);
            g.appendChild(w);
          });
          t.appendChild(g);
        }
        // A distribution strip: one row per conversation type, a line from the weakest
        // system to the strongest and a dot for each. Deliberately NOT a violin - a violin
        // needs a density, and five points per type is five points, not a density. This
        // shows the same thing a violin is asked to show, the spread within each type,
        // without inventing a curve the data cannot support.
        if (T.spread) {
          const sp = el('div', 'fw-spread');
          const top = T.spreadMax || 0.7;
          T.spread.forEach(([nm, vals]) => {
            const row = el('div', 'fw-sp-row');
            const l = el('span', 'fw-sp-n');
            l.textContent = nm;
            const track = el('div', 'fw-sp-t');
            const lo = Math.min(...vals), hi = Math.max(...vals);
            const rng = el('div', 'fw-sp-rng');
            rng.style.left = (100 * lo / top).toFixed(2) + '%';
            rng.style.width = (100 * (hi - lo) / top).toFixed(2) + '%';
            track.appendChild(rng);
            vals.forEach((v, k) => {
              const d = el('i', 'fw-sp-d');
              d.style.left = (100 * v / top).toFixed(2) + '%';
              d.style.setProperty('--i', String(k));
              d.title = v.toFixed(3);
              track.appendChild(d);
            });
            row.append(l, track);
            sp.appendChild(row);
          });
          t.appendChild(sp);
        }
        (T.items || []).forEach((it) => {
          const row = el('div', 'fw-tile-i');
          const k = el('b', '');
          k.textContent = it[0];
          const v = el('span', '');
          v.textContent = it[1] || '';
          row.append(k, v);
          t.appendChild(row);
        });
        if (T.chips) {
          const cw = el('div', 'fw-tile-chips');
          T.chips.forEach((c) => {
            const ch = el('span', 'fw-chip');
            ch.textContent = c;
            cw.appendChild(ch);
          });
          t.appendChild(cw);
        }
        wrap.appendChild(t);
      });
      if ((SM.tiles || []).length <= holeAfter) mkHole();

      const tiles = el('div', 'fw-sum-tiles');
      (SM.plots || []).forEach((P) => {
        const tile = el('figure', 'fw-tile-plot');
        tile.dataset.link = P.key;
        tile.tabIndex = 0;
        tile.style.setProperty('--tint', P.accent || 'var(--magenta)');
        const h = el('figcaption', 'fw-tile-h');
        h.textContent = P.label;
        tile.appendChild(h);

        // Sorted by its own value, because each of the three has a different leader and
        // that IS the finding. The reader should not have to scan for the tallest bar.
        const rows = (P.rows || []).slice().sort((a, b) => b[1] - a[1]);
        // The floor matters on DNSMOS: those five numbers live between 3.13 and 3.38, and
        // drawn from zero they are five identical columns. `base` says where the axis
        // starts, so the plot shows the spread that is actually there.
        const base = Number.isFinite(P.base) ? P.base : 0;
        const top = Number.isFinite(P.max) ? P.max : Math.max(...rows.map((r) => r[1]));
        const span = Math.max(1e-6, top - base);
        const dp = P.dp === undefined ? 3 : P.dp;

        // Plot and names are two grids on the same five tracks, not one grid of stacked
        // cells: the names are rotated, so they need a strip of their own to rake into
        // rather than a row that grows to fit whatever a rotated box reports.
        const cols = el('div', 'fw-cols');
        const names = el('div', 'fw-names');
        rows.forEach(([name, v]) => {
          const col = el('div', 'fw-col-b');
          const val = el('div', 'fw-col-v');
          val.textContent = v.toFixed(dp);
          const bar = el('div', 'fw-col-bar');
          bar.style.setProperty('--h',
            (100 * Math.max(0, Math.min(1, (v - base) / span))).toFixed(2) + '%');
          col.append(val, bar);
          cols.appendChild(col);

          const cell = el('div', 'fw-name-cell');
          const nm = el('div', 'fw-col-n');
          const mk = el('span', 'fw-col-mk');
          mk.innerHTML = vendorMark(name);
          const nt = el('span', '');
          nt.textContent = P.short && P.short[name] ? P.short[name] : name;
          nm.append(mk, nt);
          cell.appendChild(nm);
          names.appendChild(cell);
        });
        tile.append(cols, names);
        tiles.appendChild(tile);
      });
      // The plots go straight into the matrix rather than into a row of their own.
      while (tiles.firstChild) wrap.appendChild(tiles.firstChild);
      p.appendChild(wrap);

      // Hover and focus in EITHER direction. Held on the panel rather than on each element
      // so the two sides cannot get out of step, and so a pointer that leaves the abstract
      // for the plot it just lit does not flicker on the way.
      const lit = (key, on) => {
        p.querySelectorAll('[data-link="' + key + '"]').forEach((n) => {
          n.classList.toggle('is-lit', on);
        });
      };
      p.querySelectorAll('[data-link]').forEach((n) => {
        const k = n.dataset.link;
        n.addEventListener('mouseenter', () => lit(k, true));
        n.addEventListener('mouseleave', () => lit(k, false));
        n.addEventListener('focus', () => lit(k, true));
        n.addEventListener('blur', () => lit(k, false));
      });
    }

    /* A grouped bar chart: one cluster per conversation type, five systems in each.
       The point it exists to make is that Pass@1 is not a property of a system alone - the
       same five systems reorder across the types - and that only reads if the clusters sit
       on one axis. */
    (Array.isArray(s.grouped) ? s.grouped : s.grouped ? [s.grouped] : []).forEach((G) => {
      const fig = el('figure', 'fw-grp');
      if (G.label) {
        const cap = el('figcaption', 'fw-grp-label');
        cap.textContent = G.label;
        fig.appendChild(cap);
      }
      const top = Number.isFinite(G.max) ? G.max
        : Math.max(...G.groups.flatMap((g) => g.v));
      const plot = el('div', 'fw-grp-plot');
      G.groups.forEach((g) => {
        const cl = el('div', 'fw-grp-cluster');
        const bars = el('div', 'fw-grp-bars');
        g.v.forEach((v, k) => {
          const b = el('div', 'fw-grp-bar');
          b.style.setProperty('--h', (100 * Math.max(0, v) / top).toFixed(2) + '%');
          b.style.setProperty('--i', String(k));
          b.title = (G.systems[k] || '') + ' - ' + g.name + ' - ' + v.toFixed(3);
          bars.appendChild(b);
        });
        const nm = el('div', 'fw-grp-name');
        nm.textContent = g.name;
        cl.append(bars, nm);
        plot.appendChild(cl);
      });
      fig.appendChild(plot);
      const key = el('div', 'fw-grp-key');
      (G.systems || []).forEach((sys, k) => {
        const it = el('span', 'fw-grp-keyit');
        const sw = el('i', 'fw-grp-sw');
        sw.style.setProperty('--i', String(k));
        const tx = el('span', '');
        tx.textContent = sys;
        it.append(sw, tx);
        key.appendChild(it);
      });
      fig.appendChild(key);
      p.appendChild(fig);
    });

    /* A worked example.
       ---------------------------------------------------------------------------
       Five runs of one Pathfinding scenario, and the three numbers they produce. The
       metrics stop was a list of definitions, which is what the paper's glossary already
       is; what a reader needs is to watch GS, Pass@1 and Pass-cubed fall out of the same
       five runs, and to see why they are three different questions rather than three
       spellings of one.

       Every number here is derived from the runs beside it, in the page, so the arithmetic
       cannot drift from the illustration. */
    if (s.worked) {
      const W = s.worked;
      const fig = el('figure', 'fw-work');
      if (W.label) {
        const h = el('figcaption', 'fw-work-h');
        h.textContent = W.label;
        fig.appendChild(h);
      }
      const opt = W.optimal, lim = W.limit;
      const widest = Math.max(...W.runs.map((r) => r.blocks || 0), opt) * 1.12;
      const rows = el('div', 'fw-work-rows');
      W.runs.forEach((r, k) => {
        const row = el('div', 'fw-work-row' + (r.blocks ? (r.blocks <= opt / lim ? ' is-pass' : ' is-fail') : ' is-none'));
        const nm = el('span', 'fw-work-n');
        nm.textContent = 'Run ' + (k + 1);
        const track = el('div', 'fw-work-t');
        if (r.blocks) {
          const bar = el('div', 'fw-work-b');
          bar.style.width = (100 * r.blocks / widest).toFixed(2) + '%';
          track.appendChild(bar);
          const tick = el('i', 'fw-work-opt');
          tick.style.left = (100 * opt / widest).toFixed(2) + '%';
          const dash = el('i', 'fw-work-lim');
          dash.style.left = (100 * (opt / lim) / widest).toFixed(2) + '%';
          track.append(tick, dash);
        }
        const val = el('span', 'fw-work-v');
        val.textContent = r.blocks ? (r.blocks + ' blocks  ' + Math.round(100 * opt / r.blocks) + '%')
                                   : 'no arrival';
        row.append(nm, track, val);
        rows.appendChild(row);
      });
      fig.appendChild(rows);
      const key = el('div', 'fw-work-key');
      key.textContent = 'bar = blocks walked  ·  solid tick = the ' + opt
        + '-block optimum  ·  dashed = the ' + Math.round(lim * 100) + '% efficiency limit';
      fig.appendChild(key);

      // The three numbers, computed from the runs above rather than typed beside them.
      const n = W.runs.length;
      const arrived = W.runs.filter((r) => r.blocks).length;
      const passed = W.runs.filter((r) => r.blocks && r.blocks <= opt / lim).length;
      const C = (a, b) => (b > a ? 0 : Array.from({ length: b })
        .reduce((acc, _, i) => acc * (a - i) / (i + 1), 1));
      const p3 = C(n, 3) ? C(passed, 3) / C(n, 3) : 0;
      const out = el('div', 'fw-work-out');
      [['GS', arrived / n, arrived + ' of ' + n + ' arrived'],
       ['Pass@1', passed / n, passed + ' of ' + n + ' pass'],
       ['Pass\u00b3', p3, 'C(' + passed + ',3) / C(' + n + ',3)']].forEach(([k2, v, why]) => {
        const c = el('div', 'fw-work-cell');
        const kk = el('b', '');
        kk.textContent = k2;
        const vv = el('strong', '');
        vv.textContent = v.toFixed(3);
        const ww = el('span', '');
        ww.textContent = why;
        c.append(kk, vv, ww);
        out.appendChild(c);
      });
      fig.appendChild(out);
      p.appendChild(fig);
    }

    /* Cards: a heading, a line, and a list. Used for the three metric pillars and for the
       nine enterprise conversation types, which are the same shape of object - a named
       thing with one sentence and some contents. */
    if (s.cards && s.cards.length) {
      const grid = el('div', 'fw-cards' + (s.cardCols ? ' is-c' + s.cardCols : ''));
      s.cards.forEach((c) => {
        const card = el('article', 'fw-card');
        if (c.accent) card.style.setProperty('--tint', c.accent);
        const h = el('h3', 'fw-card-h');
        h.textContent = c.name;
        card.appendChild(h);
        if (c.line) {
          const l = el('p', 'fw-card-l');
          l.textContent = c.line;
          card.appendChild(l);
        }
        (c.items || []).forEach((it) => {
          const row = el('div', 'fw-card-i');
          const k = el('b', '');
          k.textContent = it[0];
          const v = el('span', '');
          v.textContent = it[1];
          row.append(k, v);
          card.appendChild(row);
        });
        // A short exchange, set the way a messaging app sets one, so the shape of the
        // conversation type is visible rather than described.
        (c.chat || []).forEach((line) => {
          const b = el('div', 'fw-chat ' + (line[0] === 'a' ? 'is-agent' : 'is-user'));
          b.textContent = line[1];
          card.appendChild(b);
        });
        grid.appendChild(card);
      });
      p.appendChild(grid);
    }

    /* Five recorded runs, side by side.
       ---------------------------------------------------------------------------
       Two of them are Pathfinding, so they show the walk itself, looping, the same live
       renderer the walks stop uses. The other three are enterprise calls, where there is no
       map to show - the whole event is what was said - so they loop the handful of turns in
       which the thing the conversation type is named for actually happens.

       A transcript window, not a whole call: these run four to six minutes and the moment
       that matters is twenty seconds of it. The window is chosen per run and stated in the
       config, so what is on screen is a real excerpt at a real timestamp rather than the
       opening pleasantries every call happens to share. */
    if (s.runs && s.runs.length) {
      const grid = el('div', 'fw-runs');
      grid.style.setProperty('--n', String(s.runs.length));
      s.runs.forEach((r) => {
        const fig = el('figure', 'fw-run is-' + (r.outcome || 'ok'));
        fig.dataset.kind = r.map ? 'map' : 'call';
        const head = el('figcaption', 'fw-run-head');
        const ty = el('span', 'fw-run-type');
        ty.textContent = r.type || '';
        const wh = el('span', 'fw-run-where');
        wh.textContent = r.world || '';
        head.append(ty, wh);
        // Which system is speaking. Five tiles from four different systems is not a detail
        // a reader can be expected to infer, and an unattributed sample invites the reading
        // that all five are the same agent.
        if (r.model) {
          const md = el('span', 'fw-run-model');
          md.innerHTML = vendorMark(r.model);
          const mn = el('b', '');
          mn.textContent = r.model;
          md.appendChild(mn);
          head.appendChild(md);
        }
        const box = el('div', 'fw-run-box');
        const wait = el('div', 'fw-map-wait');
        wait.textContent = 'loading';
        box.appendChild(wait);
        fig.append(head, box);
        if (r.map) {
          fig.dataset.key = r.map;
          fig.tabIndex = 0;
          fig.setAttribute('role', 'button');
          fig.setAttribute('aria-label', (r.type || '') + ', ' + (r.world || '')
            + '. Opens full size, with a step control.');
          const open = () => openWalk({ key: r.map, cond: r.type, note: r.world });
          fig.addEventListener('click', open);
          fig.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
          });
        } else {
          fig.dataset.call = r.call;
          fig.dataset.from = String(r.from);
          fig.dataset.to = String(r.to);
        }
        grid.appendChild(fig);
      });
      p.appendChild(grid);
      runStops.push({ i, cfg: s.runs, grid });
    }

    // Front matter. The paper's own abstract, under its own heading, exactly as a project
    // page for a paper should open: what the work is, before any claim about it.
    if (s.abstract) {
      const ab = el('section', 'fw-abstract');
      const ah = el('h2', 'fw-abstract-h');
      ah.textContent = s.abstractLabel || 'Abstract';
      ab.appendChild(ah);
      (Array.isArray(s.abstract) ? s.abstract : [s.abstract]).forEach((para) => {
        const q = el('p', 'fw-abstract-p');
        q.textContent = para;
        ab.appendChild(q);
      });
      p.appendChild(ab);
    }

    // A bar chart, one series. Deliberately not a library: the whole figure is five rows of
    // two divs, and every pixel of width is a number from the table rather than a scale
    // somebody chose. The interval is drawn, not just printed - a 0.533 with a half-width of
    // 0.133 and a 0.490 with a half-width of 0.039 are different claims, and a bare bar
    // chart shows them as the same kind of thing.
    if (s.bars) {
      const B = s.bars;
      const rows = B.rows || [];
      // The axis has to clear the widest whisker, not the tallest bar, or the top interval
      // is drawn running off the end of its own track.
      const reach = Math.max(...rows.map((r) => r.v + (r.pm || 0)), 0.0001);
      const MAX = Number.isFinite(B.max) ? B.max : Math.ceil(reach * 10) / 10;
      const fig = el('figure', 'fw-bars');
      if (B.label) {
        const cap = el('figcaption', 'fw-bars-label');
        cap.textContent = B.label;
        fig.appendChild(cap);
      }
      const list = el('div', 'fw-bars-list');
      const fmt = (x) => x.toFixed(B.dp === undefined ? 3 : B.dp);
      rows.forEach((r) => {
        const row = el('div', 'fw-bar-row' + (r.v <= 0 ? ' is-zero' : ''));
        // The system's own colour, the same one it carries on the opening plot and beside
        // its recorded call, so a reader tracks one system across the page by hue.
        row.style.setProperty('--sys', sysColor(r.name || r.system || ''));
        // Focusable, so the read-out is reachable without a pointer. A <div> with tabindex
        // rather than a <button>: there is nothing to activate, and announcing five buttons
        // that do nothing is worse than announcing five values.
        row.tabIndex = 0;
        const nm = el('div', 'fw-bar-name');
        nm.innerHTML = vendorMark(r.system);
        const nmt = el('span', '');
        nmt.textContent = r.system;
        nm.appendChild(nmt);
        const track = el('div', 'fw-bar-track');
        const fill = el('div', 'fw-bar-fill');
        fill.style.setProperty('--w', (100 * r.v / MAX).toFixed(2) + '%');
        track.appendChild(fill);
        if (r.pm) {
          const ci = el('div', 'fw-bar-ci');
          const lo = Math.max(0, r.v - r.pm), hi = Math.min(MAX, r.v + r.pm);
          ci.style.left = (100 * lo / MAX).toFixed(2) + '%';
          ci.style.width = (100 * (hi - lo) / MAX).toFixed(2) + '%';
          track.appendChild(ci);
        }
        const val = el('div', 'fw-bar-val');
        const vb = el('strong', '');
        vb.textContent = fmt(r.v);
        val.appendChild(vb);
        if (r.pm) {
          const pm = el('span', 'fw-pm');
          pm.textContent = '±' + fmt(r.pm).replace(/^0/, '');
          val.appendChild(pm);
        }
        const tip = el('div', 'fw-bar-tip');
        tip.textContent = r.tip || (r.system + ' · ' + (B.metric || 'value') + ' ' + fmt(r.v)
          + (r.pm ? ' (95% interval ' + fmt(r.v - r.pm) + ' to ' + fmt(r.v + r.pm) + ')' : ''));
        row.append(nm, track, val, tip);
        // No aria-label. It was prohibited here - the row is a nameless `generic`, and a
        // name on one is unreliable in every major screen reader - and it was also
        // unnecessary: the system and its value are real text inside the row already. The
        // track and the whisker are the decoration, so those are what get hidden.
        track.setAttribute('aria-hidden', 'true');
        tip.setAttribute('aria-hidden', 'true');
        list.appendChild(row);
      });
      fig.appendChild(list);
      if (B.axis !== false) {
        // Three children, matching the row grid: an empty cell under the names, the ticks
        // over the track, an empty cell under the values. Laid out rather than nudged
        // across with a margin, because the two were measured in different fonts' `ch` and
        // the axis ended up 64px left of the bars it labels.
        const ax = el('div', 'fw-bars-axis');
        ax.setAttribute('aria-hidden', 'true');    // the values are on the rows themselves
        const ticks = el('div', 'fw-axis-ticks');
        [0, MAX / 2, MAX].forEach((t) => {
          const tk = el('span', '');
          tk.textContent = fmt(t);
          ticks.appendChild(tk);
        });
        ax.append(el('span', ''), ticks, el('span', ''));
        fig.appendChild(ax);
      }
      if (B.note) {
        const n = el('p', 'fw-bars-note');
        n.textContent = B.note;
        fig.appendChild(n);
      }
      p.appendChild(fig);
    }

    // The main table, as the paper prints it: three pillars over eleven metrics, every cell
    // carrying its own 95% bootstrap half-width. The half-widths are the reason this is worth
    // the width it costs - without them the Pathfinding block reads as five separated systems
    // when three of its intervals overlap.
    if (s.pillars) {
      const P = s.pillars;
      const cols = P.groups.flatMap((g) => g.cols);
      const tbl = el('table', 'fw-pillars' + (P.reveal ? ' is-staged' : ''));
      if (P.caption) {
        const cp = el('caption', '');
        cp.textContent = P.caption;
        tbl.appendChild(cp);
      }
      const thead = el('thead', '');
      const gr = el('tr', 'fw-p-groups');
      gr.appendChild(el('td', 'fw-p-corner'));
      P.groups.forEach((g) => {
        const th = el('th', 'fw-p-group');
        th.colSpan = g.cols.length;
        th.scope = 'colgroup';
        th.textContent = g.name;
        gr.appendChild(th);
      });
      const mr = el('tr', 'fw-p-metrics');
      const corner = el('th', 'fw-p-sys');
      corner.scope = 'col';
      corner.textContent = P.rowHead || 'System';
      mr.appendChild(corner);
      let ci = 0;
      P.groups.forEach((g) => g.cols.forEach((c) => {
        const th = el('th', '');
        th.scope = 'col';
        th.textContent = c;
        th.dataset.col = String(ci++);
        mr.appendChild(th);
      }));
      thead.append(gr, mr);
      // Best per column, computed rather than hand-marked, and direction-aware: this suite
      // has lower-is-better columns, and a silent max would bold the worst system in one.
      // Non-numeric cells are filtered rather than fed to Math.max, which returns NaN and
      // unbolds a whole column with nothing to show that anything went wrong.
      const dirs = P.best || cols.map(() => 'high');
      const best = cols.map((_, j) => {
        const nums = P.rows.map((r) => parseFloat(r.vals[j] && r.vals[j][0]))
                           .filter(Number.isFinite);
        if (!nums.length) return null;
        return dirs[j] === 'low' ? Math.min(...nums) : Math.max(...nums);
      });
      const tb = el('tbody', '');
      P.rows.forEach((r, ri) => {
        const tr = el('tr', '');
        tr.dataset.row = String(ri);
        const th = el('th', 'fw-p-sys');
        th.scope = 'row';
        const nm = el('span', 'fw-m-sysin');
        nm.innerHTML = vendorMark(r.system);
        const nmt = el('span', '');
        nmt.textContent = r.system;
        nm.appendChild(nmt);
        th.appendChild(nm);
        tr.appendChild(th);
        cols.forEach((_, j) => {
          const cell = r.vals[j] || ['', ''];
          const td = el('td', (best[j] !== null && parseFloat(cell[0]) === best[j]) ? 'is-best' : '');
          const b = el('b', '');
          b.textContent = cell[0];
          td.appendChild(b);
          if (cell[1]) {
            const pm = el('i', 'fw-pm');
            pm.textContent = '±' + cell[1];
            td.appendChild(pm);
          }
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      tbl.append(thead, tb);
      const scroller = el('div', 'fw-pillars-wrap');
      scroller.appendChild(tbl);
      p.appendChild(scroller);
    }

    // The recorded walks, live. Not screenshots and not a video: each panel is the same
    // renderer the gallery at the demo page runs, replaying a real scored conversation from
    // the corpus, looping. What arrives here is `maps.cells` in reading order; which of them
    // are on screen at a given moment is decided by `data-step`, so the grid builds up one
    // job at a time as the reader scrolls through the band.
    if (s.maps) {
      const M = s.maps;
      if (M.label) {
        const ml = el('div', 'fw-cases-label');
        ml.textContent = M.label;
        p.appendChild(ml);
      }
      const grid = el('div', 'fw-maps');
      grid.style.setProperty('--cols', String(M.cols || 3));
      (M.cells || []).forEach((c, idx) => {
        const fig = el('figure', 'fw-map is-' + (c.outcome || 'ok'));
        fig.dataset.at = String(c.at === undefined ? idx : c.at);
        fig.dataset.key = c.key;
        const head = el('figcaption', 'fw-map-head');
        const cond = el('span', 'fw-map-cond');
        cond.textContent = c.cond || '';
        const verdict = el('span', 'fw-map-verdict');
        verdict.textContent = c.verdict || '';
        head.append(cond, verdict);
        const box = el('div', 'fw-map-box');
        // What stands here until the payload arrives, and what stays if it never does. A
        // silently empty box would read as a rendering bug rather than as a slow fetch.
        const wait = el('div', 'fw-map-wait');
        wait.textContent = 'loading the walk';
        box.appendChild(wait);
        const foot = el('div', 'fw-map-foot');
        foot.textContent = c.note || '';
        fig.append(head, box, foot);
        // The whole tile opens the walk, not just the map: at this size the map is a
        // 200px-tall target and the caption above it is the part that reads as clickable.
        fig.tabIndex = 0;
        fig.setAttribute('role', 'button');
        // The note under the map is clamped to two lines, so the mechanism sentence has to
        // reach the reader some other way. Both routes carry it: the tooltip for a pointer,
        // the accessible name for everyone else.
        const full = [c.cond, c.verdict, c.note, c.detail].filter(Boolean).join('. ');
        if (c.detail) fig.title = c.detail;
        fig.setAttribute('aria-label', full + '. Opens full size, with a step control.');
        const open = () => openWalk(c);
        fig.addEventListener('click', open);
        fig.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        grid.appendChild(fig);
      });
      p.appendChild(grid);
      mapStops.push({ i, cfg: M, grid });
    }

    // A pair stop sits on the moment the chain shows two globes side by side, so the copy
    // is two columns rather than one - each world keeps its own regime, its own leading
    // system and its own number instead of being merged into a paragraph about both.
    if (s.pair && s.pair.length) {
      const pw = el('div', 'fw-pair');
      s.pair.forEach((c) => {
        const col = el('div', 'fw-col');
        const ce = el('div', 'fw-col-eyebrow');
        ce.textContent = c.eyebrow || '';
        col.appendChild(ce);
        if (c.title) {
          const ct = el('h3', 'fw-col-title');
          ct.textContent = c.title;
          col.appendChild(ct);
        }
        // The leading system and the figure it leads on, side by side. Reporting a model
        // without the number it earned is the loose framing this page is meant to avoid.
        if (c.model || c.stat) {
          const line = el('div', 'fw-col-line');
          if (c.model) {
            const m = el('div', 'fw-col-model');
            m.innerHTML = vendorMark(c.model);
            const mt = el('span', '');
            mt.textContent = c.model;
            m.appendChild(mt);
            line.appendChild(m);
          }
          if (c.stat) {
            const st = el('div', 'fw-col-stat');
            const sv = el('strong', '');
            sv.textContent = c.stat[0];
            const sl = el('span', '');
            sl.textContent = c.stat[1];
            st.append(sv, sl);
            line.appendChild(st);
          }
          col.appendChild(line);
        }
        const cb = el('p', 'fw-col-body');
        cb.textContent = c.body || '';
        col.appendChild(cb);
        pw.appendChild(col);
      });
      p.appendChild(pw);
    }
    // Individual scored runs, drawn from the corpus. `stats` is supplied per card rather
    // than computed from a fixed triple: the runs do not all report the same quantities,
    // and inventing the missing ones to fill a column is how a figure stops being evidence.
    if (s.cases && s.cases.length) {
      if (s.casesLabel) {
        const cl = el('div', 'fw-cases-label');
        cl.textContent = s.casesLabel;
        p.appendChild(cl);
      }
      const grid = el('div', 'fw-cases');
      s.cases.forEach((cs) => {
        const card = el('article', 'fw-case is-' + cs.outcome);
        card.dataset.at = String(cs.at);
        const head = el('div', 'fw-case-head');
        const cond = el('span', 'fw-case-cond');
        cond.textContent = cs.cond;
        const verdict = el('span', 'fw-case-verdict');
        verdict.textContent = cs.verdict || (cs.outcome === 'ok' ? 'Arrived' : 'Not arrived');
        head.append(cond, verdict);
        const mod = el('div', 'fw-case-model');
        mod.innerHTML = vendorMark(cs.agent);
        const mt = el('span', '');
        mt.textContent = cs.agent;
        mod.appendChild(mt);
        const nums = el('div', 'fw-case-nums');
        (cs.stats || []).forEach(([v, l]) => {
          const cell = el('div', 'fw-case-num');
          const big = el('strong', '');
          big.textContent = v;
          const cap = el('span', '');
          cap.textContent = l;
          cell.append(big, cap);
          nums.appendChild(cell);
        });
        card.append(head, mod, nums);
        if (cs.note) {
          const n = el('p', 'fw-case-note');
          n.textContent = cs.note;
          card.appendChild(n);
        }
        grid.appendChild(card);
      });
      p.appendChild(grid);
    }
    // The results table. Deliberately narrow: one column per pillar plus reliability, which
    // is the fewest columns that still shows a different system winning each one.
    if (s.metrics) {
      const M = s.metrics;
      const tbl = el('table', 'fw-metrics');
      if (M.caption) {
        const cp = el('caption', '');
        cp.textContent = M.caption;
        tbl.appendChild(cp);
      }
      const thead = el('thead', '');
      const hr = el('tr', '');
      const corner = el('th', 'fw-m-sys');
      corner.scope = 'col';
      corner.textContent = M.rowHead || 'System';
      hr.appendChild(corner);
      M.cols.forEach((c) => {
        const th = el('th', '');
        th.scope = 'col';
        th.textContent = c;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      // Best per column, found rather than hand-marked, so a corrected number can never
      // leave the bold on the wrong row. `best` per column is a direction, not an assumption:
      // this suite contains lower-is-better columns too (over-effort ratio, under-effort
      // share), and a silent max would bold the worst system in one of those. Non-numeric
      // cells are filtered rather than fed to Math.max, which would return NaN and unbold
      // the entire column with no sign that anything went wrong.
      const dirs = M.best || M.cols.map(() => 'high');
      const best = M.cols.map((_, j) => {
        const nums = M.rows.map((r) => parseFloat(r.vals[j])).filter(Number.isFinite);
        if (!nums.length) return null;
        return dirs[j] === 'low' ? Math.min(...nums) : Math.max(...nums);
      });
      const tb = el('tbody', '');
      M.rows.forEach((r) => {
        const tr = el('tr', '');
        const th = el('th', 'fw-m-sys');
        th.scope = 'row';
        // The flex row lives on an inner span, never on the <th>. Flexing the cell itself
        // takes it out of the table formatting context, so the browser wraps it in an
        // anonymous cell and the row rule and padding paint on the wrong box.
        const nm = el('span', 'fw-m-sysin');
        nm.innerHTML = vendorMark(r.system);
        const nmt = el('span', '');
        nmt.textContent = r.system;
        nm.appendChild(nmt);
        th.appendChild(nm);
        tr.appendChild(th);
        r.vals.forEach((v, j) => {
          const td = el('td', (best[j] !== null && parseFloat(v) === best[j]) ? 'is-best' : '');
          td.textContent = v;
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      tbl.append(thead, tb);
      p.appendChild(tbl);
    }
    if (s.tags && s.tags.length) {
      if (s.tagsLabel) {
        const tl = el('div', 'fw-cases-label');
        tl.textContent = s.tagsLabel;
        p.appendChild(tl);
      }
      const tw = el('div', 'fw-tags' + (s.tagsLabel ? ' is-labelled' : ''));
      s.tags.forEach((t) => {
        // A trailing marker denotes a tag that is qualified in the note below, rather than
        // a different kind of thing. Held out of the label so it cannot be read as part of
        // the name, and carried on the element so the styling has something to hook.
        const marked = /\*$/.test(t);
        const c = el('span', 'fw-tag' + (marked ? ' is-marked' : ''));
        c.textContent = marked ? t.slice(0, -1) : t;
        tw.appendChild(c);
      });
      p.appendChild(tw);
    }
    if (s.foot) {
      const f = el('p', 'fw-foot');
      f.textContent = s.foot;
      p.appendChild(f);
    }
    if (s.note) {
      const n = el('p', 'fw-note');
      n.textContent = s.note;
      p.appendChild(n);
    }
    if (s.cta) {
      const cw = el('div', 'fw-cta');
      (s.cta || []).forEach((c, i) => {
        const a = el('a', i === 0 ? 'fw-btn fw-btn-primary' : 'fw-btn');
        a.href = c.href;
        a.textContent = c.label;
        cw.appendChild(a);
      });
      p.appendChild(cw);
    }
    // A table stacked under prose is the single tallest thing this page can produce, and on
    // the stacked shell panel height is taken straight out of the film. Set beside the prose
    // instead it costs nothing: measured at 1560x900 the results panel drops from 1106px to
    // roughly a third of that, and the film keeps its size.
    //
    // This runs LAST, after every other block exists. Wrapping earlier left the tags, note
    // and call-to-action as direct children of a grid, where they auto-placed into row two
    // rather than flowing under the prose.
    if (s.metrics) {
      const tbl = p.querySelector('.fw-metrics');
      const main = el('div', 'fw-panel-main');
      Array.from(p.childNodes).forEach((n) => { if (n !== tbl) main.appendChild(n); });
      p.append(main, tbl);          // tbl is already a child; append moves it to the end
      p.classList.add('fw-panel-metrics');
    }
    copyWrap.appendChild(p);
    return p;
  });
  stage.append(copyWrap, status);

  // Route rail. Clicking a stop scrolls to it, which is the only navigation a
  // scroll page can offer that does not fight the scroll itself.
  const rail = el('nav', 'fw-rail');
  rail.setAttribute('aria-label', 'Flight route');
  // A column of unlabelled dots is a slide-deck affordance. A research page is read by
  // scrolling and navigated by a named bar across the top, so the dots come out wherever
  // that bar is present.
  if (config.rail === false) rail.hidden = true;
  const dots = S.map((s, i) => {
    const b = el('button', 'fw-dot');
    b.type = 'button';
    b.innerHTML = '<span class="fw-dot-mark"></span><span class="fw-dot-label"></span>';
    b.querySelector('.fw-dot-label').textContent = s.label;
    b.addEventListener('click', () => {
      window.scrollTo({ top: centrePx(i) - vh() / 2, behavior: reduce ? 'instant' : 'smooth' });
      // Wait for the panel to become operable rather than guessing at 600ms. Over a long
      // jump it is still inert at that point, and focus() on an inert element is a silent
      // no-op - the reader gets a scroll, no focus move and no announcement.
      const p = panels[i];
      p.tabIndex = -1;
      let tries = 0;
      (function land() {
        if (!p.inert) { p.focus({ preventScroll: true }); return; }
        if (++tries < 90) requestAnimationFrame(land);
      })();
    });
    rail.appendChild(b);
    return b;
  });
  stage.appendChild(rail);

  // Persistent index of every world. The film can only hold one or two globes at a time,
  // so on its own it keeps five of the six off screen at any moment and the set never reads
  // as a set. These stay up the whole way down, dimmed, and light up when the flight
  // reaches them - so "six worlds" is visible rather than merely claimed.
  const globes = (config.globes || []).map((g) => {
    // Both of these failed silently before: an out-of-range index made centrePx return
    // undefined so the click did nothing, and a stop that arrived as a string from JSON
    // never matched the strict compare in paintCopy, so that world never lit up.
    const stopIdx = Number(g.stop);
    if (!Number.isInteger(stopIdx) || stopIdx < 0 || stopIdx >= N) {
      console.warn('flight: globe "' + g.label + '" has stop ' + JSON.stringify(g.stop) +
                   ', which is not a section index in 0..' + (N - 1));
    }
    const b = el('button', 'fw-globe');
    b.type = 'button';
    b.title = g.label;
    const im = artImg(g.src, '', 'fw-globe-img');   // the label below is the accessible name
    const cap = el('span', 'fw-globe-label');
    cap.textContent = g.label;
    b.append(im, cap);
    b.addEventListener('click', () => {
      const c = centrePx(stopIdx);
      if (Number.isFinite(c)) {
        window.scrollTo({ top: c - vh() / 2, behavior: reduce ? 'instant' : 'smooth' });
      }
    });
    b.__stop = stopIdx;
    return b;
  });
  if (globes.length) {
    const strip = el('nav', 'fw-globes');
    strip.setAttribute('aria-label', 'The six worlds');
    globes.forEach((b) => strip.appendChild(b));
    stage.appendChild(strip);
  }

  /* The section bar.
     ---------------------------------------------------------------------------
     Named sections across the top, in a bar, the way a paper's own project page is
     navigated. It is not a second timeline: each entry is one of the same stops the flight
     already has, so clicking one flies there exactly as a rail dot did, and the entry that
     lights is whichever section CONTAINS the live stop rather than whichever was clicked -
     so it stays right when the reader scrolls instead of clicking. */
  const navItems = (config.nav || []).map((n) => {
    const from = S.findIndex((x) => x.id === n.at);
    const to = n.to ? S.findIndex((x) => x.id === n.to) : from;
    const b = el('button', 'fw-nav-item');
    b.type = 'button';
    b.textContent = n.label;
    if (from < 0) {
      console.warn('flight: nav entry "' + n.label + '" points at section "' + n.at +
                   '", which does not exist');
    }
    b.addEventListener('click', () => {
      const c = centrePx(from);
      if (Number.isFinite(c)) {
        window.scrollTo({ top: c - vh() / 2, behavior: reduce ? 'instant' : 'smooth' });
      }
    });
    b.__from = from;
    b.__to = to < 0 ? from : to;
    return b;
  });
  if (navItems.length) {
    const bar = el('nav', 'fw-nav');
    bar.setAttribute('aria-label', 'Sections');
    navItems.forEach((b) => bar.appendChild(b));
    const host = document.querySelector('[data-nav-host]') || stage;
    host.appendChild(bar);
  }

  const hint = el('div', 'fw-hint');
  hint.textContent = config.hint || 'scroll to fly in';
  stage.appendChild(hint);

  /* THE OPENING.
     ---------------------------------------------------------------------------
     A block in NORMAL FLOW, above the stage, one viewport tall. Not a stop.
     A stop is pinned and cross-fades, which is right for the flight and wrong for a title
     page: a reader scrolling down expects the first screen to travel up and off, taking
     its own content with it, not to dissolve in place while the words hold still. So this
     is not in the sections list at all - it is a section of the document, and the flight
     begins underneath it. `measure()` adds its height to the lead, which is what keeps
     every stop's geometry correct below it. */
  let openEl = null;
  if (config.opening) {
    const O = config.opening;
    openEl = el('section', 'fw-open');
    const inner = el('div', 'fw-open-in');
    if (O.title) {
      const h = el('h1', 'fw-open-title');
      h.textContent = O.title;
      inner.appendChild(h);
    }
    const g = el('div', 'fw-open-grid');
    const cell = (cls) => { const c = el('div', 'fw-open-cell ' + cls); g.appendChild(c); return c; };
    (O.cells || []).forEach((c, k) => {
      // The mark is the middle cell of the three by three, so it is inserted at index 4.
      if (k === 4) {
        const mid = cell('is-mark');
        if (O.mark) mid.appendChild(artImg(O.mark, O.markAlt || '', 'fw-open-mark'));
      }
      const box = cell(c.wide ? 'is-wide' : '');
      if (c.label) {
        const l = el('div', 'fw-open-lab');
        l.textContent = c.label;
        box.appendChild(l);
      }
      if (c.text) {
        const t = el('p', 'fw-open-text');
        t.textContent = c.text;
        box.appendChild(t);
      }
      (c.items || []).forEach((it) => {
        const row = el('div', 'fw-open-i');
        const a = el('b', '');
        a.textContent = it[0];
        const b = el('span', '');
        b.textContent = it[1] || '';
        row.append(a, b);
        box.appendChild(row);
      });
      if (c.chips) {
        const cw = el('div', 'fw-open-chips');
        c.chips.forEach((x) => {
          const ch = el('span', 'fw-open-chip');
          ch.textContent = x;
          cw.appendChild(ch);
        });
        box.appendChild(cw);
      }
      if (c.figure) {
        const im = artImg(c.figure, c.figureAlt || '', 'fw-open-fig');
        box.appendChild(im);
      }
      if (c.worlds) {
        const ww = el('div', 'fw-open-worlds');
        c.worlds.forEach(([nm, src]) => {
          const w = el('div', 'fw-open-w');
          w.appendChild(artImg(src, '', 'fw-open-wimg'));
          const l = el('span', '');
          l.textContent = nm;
          w.appendChild(l);
          ww.appendChild(w);
        });
        box.appendChild(ww);
      }
      if (c.plot) {
        const P = c.plot;
        box.classList.add('is-plot');
        box.style.setProperty('--tint', P.accent || 'var(--magenta)');
        const rws = P.rows.slice().sort((a, b) => b[1] - a[1]);
        const base = Number.isFinite(P.base) ? P.base : 0;
        const top = Number.isFinite(P.max) ? P.max : Math.max(...rws.map((r) => r[1]));
        const span = Math.max(1e-6, top - base);
        const cols = el('div', 'fw-open-cols');
        const names = el('div', 'fw-open-names');
        rws.forEach(([nm, v]) => {
          const cb = el('div', 'fw-open-cb');
          cb.style.setProperty('--sys', sysColor(nm));
          // The vendor's mark on the column itself. It was only in the rotated name row,
          // at 9px, which is not a logo so much as a smudge.
          const mk = el('div', 'fw-open-mk');
          mk.innerHTML = vendorMark(nm);
          const val = el('div', 'fw-open-cv');
          val.textContent = v.toFixed(P.dp === undefined ? 3 : P.dp);
          const bar = el('div', 'fw-open-bar');
          bar.style.height = (100 * Math.max(0, Math.min(1, (v - base) / span))).toFixed(2) + '%';
          cb.append(mk, val, bar);
          cols.appendChild(cb);
          const nc = el('div', 'fw-open-nc');
          const nn = el('div', 'fw-open-nm');
          nn.innerHTML = vendorMark(nm);
          const nt = el('span', '');
          nt.textContent = (P.short && P.short[nm]) || nm;
          nn.appendChild(nt);
          nc.appendChild(nn);
          names.appendChild(nc);
        });
        box.append(cols, names);
      }
    });
    inner.appendChild(g);
    openEl.appendChild(inner);
    root.appendChild(openEl);
  }

  const spacer = el('div', 'fw-spacer');
  root.append(stage, spacer);

  // ---------------------------------------------------------------- the walks
  /* Six recorded conversations, replayed live inside the page.
     ------------------------------------------------------------------------
     `walkmap.js` already does all of this: renderGeoDemo({GEO, host, compact}) is the same
     instance the demo gallery runs, looping, and it hands back a `destroy()` and a read-only
     `probe`. Nothing here re-implements a map. What this section owns is the three things a
     scroll page adds on top:

       - WHEN a payload is fetched. Six walks are ~410 KB, which is not much next to the film
         but is entirely wasted on a reader who never reaches the Pathfinding stop.
       - WHICH tiles are alive. Each one is a rAF loop with a resize observer; six of them
         running behind a 1080p scrub is a measurable frame cost, and they are off screen for
         most of the page. They are built on approach and torn down on departure.
       - What a click does. The tile is deliberately the compact dress with no controls; the
         overlay is the SAME renderer without `compact`, which is where the step bar lives.
         So "play the route one block at a time" is the renderer's own transport, not a
         second implementation that could disagree with it.

     No audio anywhere on this path. The recordings are megabytes each and the tiles loop
     silently by design, so `setVoice` is never called and no *_voice.json is ever fetched. */
  const MAPS = config.maps || {};
  const mapPayloads = {};             // key -> parsed payload, fetched once
  const mapLive = {};                 // key -> the live compact instance
  let mapsFetch = null;

  function mapsReady() {
    if (mapsFetch) return mapsFetch;
    const keys = [];
    mapStops.forEach((ms) => (ms.cfg.cells || []).forEach((c) => keys.push(c.key)));
    // The single-file export inlines the walks here, because a file:// page cannot fetch a
    // sibling - it is a CORS failure, not a 404 - so without this the tiles would sit on
    // their placeholders forever in exactly the copy that gets emailed around.
    const cache = window.__DW_WALKS || null;
    if (cache && keys.every((k) => cache[k])) {
      keys.forEach((k) => { mapPayloads[k] = cache[k]; });
      mapsFetch = Promise.resolve();
      return mapsFetch;
    }
    const base = MAPS.base || '../';
    mapsFetch = Promise.all(keys.map((k) =>
      fetch(base + 'geo_' + k + '.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((j) => { mapPayloads[k] = j; })
        .catch((e) => { console.warn('flight: walk "' + k + '" did not load:', e.message); })));
    return mapsFetch;
  }

  let mapEpoch = 0;
  function mountMaps(stop) {
    if (typeof window.renderGeoDemo !== 'function') return;
    const token = ++mapEpoch;
    mapsReady().then(() => {
      // The payloads can land long after the reader has moved on - a cold, slow connection
      // behind a 39 MB film - and unmountMaps only runs on the NEXT stop change, so six
      // renderers would stay live behind an unrelated stop. Measured cost of that: 1,095
      // setAttribute calls per frame against 17 with them down.
      if (token !== mapEpoch) return;
      mapStops.forEach((ms) => {
        if (ms.i !== stop) return;
        ms.grid.querySelectorAll('.fw-map').forEach((fig) => {
          const key = fig.dataset.key;
          if (mapLive[key] || !mapPayloads[key]) return;
          const box = fig.querySelector('.fw-map-box');
          box.innerHTML = '';
          mapLive[key] = window.renderGeoDemo({ GEO: mapPayloads[key], host: box, compact: true });
        });
      });
    });
  }

  function unmountMaps(except) {
    mapStops.forEach((ms) => {
      if (ms.i === except) return;
      ms.grid.querySelectorAll('.fw-map').forEach((fig) => {
        const key = fig.dataset.key;
        const inst = mapLive[key];
        if (!inst) return;
        delete mapLive[key];
        try { inst.destroy(); } catch (e) { /* already gone */ }
        const box = fig.querySelector('.fw-map-box');
        const wait = el('div', 'fw-map-wait');
        wait.textContent = 'loading the walk';
        box.appendChild(wait);
      });
    });
  }

  // Built on the APPROACH, not on arrival: a renderer needs a moment to lay itself out, and
  // mounting six of them at the instant the stop lights up puts that work in the same frame
  // as the panel's own fade.
  function mapsOnStopChange(stop) {
    if (!mapStops.length) return;
    const near = mapStops.find((ms) => Math.abs(ms.i - stop) <= 1);
    if (near) mountMaps(near.i);
    unmountMaps(near ? near.i : -1);
  }

  // The full walk, over the page. Same payload, same renderer, without `compact` - which is
  // what brings back the step scrubber, the status line and the legend the tile hides.
  let walkOverlay = null;
  let walkInst = null;
  let walkOpener = null;

  function closeWalk() {
    if (!walkOverlay) return;
    if (walkInst) { try { walkInst.destroy(); } catch (e) { /* gone */ } walkInst = null; }
    walkOverlay.remove();
    walkOverlay = null;
    document.removeEventListener('keydown', onWalkKey, true);
    // Focus goes back where it came from. Dropping it to <body> after a dialog closes leaves
    // a keyboard reader at the top of the document with no announcement.
    if (walkOpener) { try { walkOpener.focus(); } catch (e) { /* detached */ } walkOpener = null; }
  }

  function onWalkKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeWalk(); return; }
    if (e.key !== 'Tab' || !walkOverlay) return;
    // A modal that lets Tab escape into the page behind it is a modal in appearance only.
    const f = walkOverlay.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openWalk(cell) {
    if (typeof window.renderGeoDemo !== 'function') return;
    // Read BEFORE closing: closeWalk restores focus to the previous opener, so reading it
    // afterwards recorded the wrong element to return to on a second open.
    const opener = document.activeElement;
    closeWalk();
    walkOpener = opener;
    const ov = el('div', 'fw-walk');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', (cell.cond || 'Walk') + ', full size');
    const card = el('div', 'fw-walk-card');
    const head = el('header', 'fw-walk-head');
    const t = el('div', 'fw-walk-title');
    t.textContent = cell.cond || '';
    const sub = el('div', 'fw-walk-sub');
    // Full size, so the sentence the tile had to clamp fits here.
    sub.textContent = [cell.note, cell.detail].filter(Boolean).join(' ');
    const x = el('button', 'fw-walk-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.textContent = '×';
    x.addEventListener('click', closeWalk);
    head.append(t, sub, x);
    const body = el('div', 'fw-walk-body');
    card.append(head, body);
    ov.appendChild(card);
    // Clicks on the backdrop close; clicks inside must not, or every interaction with the
    // map dismisses the thing it is inside.
    ov.addEventListener('click', (e) => { if (e.target === ov) closeWalk(); });
    document.body.appendChild(ov);
    walkOverlay = ov;
    document.addEventListener('keydown', onWalkKey, true);
    // Immediately, not inside the payload promise. Focus used to move only on the success
    // branch, so a walk that failed to load left focus on the page BEHIND the dialog and
    // Tab walked straight through it - and even on the happy path there was a window of
    // however long the fetch took.
    x.focus();
    mapsReady().then(() => {
      if (walkOverlay !== ov) return;                 // closed while the payload was in flight
      if (!mapPayloads[cell.key]) {
        body.textContent = 'This walk did not load.';
        return;
      }
      walkInst = window.renderGeoDemo({ GEO: mapPayloads[cell.key], host: body });
    });
  }

  // ------------------------------------------------------- the recorded calls
  /* A transcript window, looping. Two turns visible at a time, advancing on the gap the
     recording itself had between them (compressed, or a six-minute call would take six
     minutes to loop) and starting over at the end.

     No audio. The recordings are megabytes each and the page is silent by design; what is
     being shown is what was said and when, which the transcript carries on its own. */
  const CALLS = config.calls || {};
  const callData = {};
  let callsFetch = null;
  const callTimers = [];

  function callsReady() {
    if (callsFetch) return callsFetch;
    const keys = [];
    runStops.forEach((rs) => rs.cfg.forEach((r) => { if (r.call) keys.push(r.call); }));
    const cache = window.__DW_CALLS || null;
    if (cache && keys.every((k) => cache[k])) {
      keys.forEach((k) => { callData[k] = cache[k]; });
      callsFetch = Promise.resolve();
      return callsFetch;
    }
    const base = CALLS.base || '../';
    callsFetch = Promise.all(keys.map((k) =>
      fetch(base + k + '.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((j) => { callData[k] = j; })
        .catch((e) => { console.warn('flight: call "' + k + '" did not load:', e.message); })));
    return callsFetch;
  }

  function stopCalls() {
    while (callTimers.length) clearTimeout(callTimers.pop());
  }

  function mountRuns(stop) {
    stopCalls();
    runStops.forEach((rs) => {
      if (rs.i !== stop) return;
      // The two Pathfinding tiles are the same live renderer the walks stop uses.
      if (typeof window.renderGeoDemo === 'function') {
        mapsReady().then(() => {
          rs.grid.querySelectorAll('.fw-run[data-kind="map"]').forEach((fig) => {
            const k = fig.dataset.key;
            if (mapLive[k] || !mapPayloads[k]) return;
            const box = fig.querySelector('.fw-run-box');
            box.innerHTML = '';
            mapLive[k] = window.renderGeoDemo({ GEO: mapPayloads[k], host: box, compact: true });
          });
        });
      }
      callsReady().then(() => {
        rs.grid.querySelectorAll('.fw-run[data-kind="call"]').forEach((fig) => {
          const d = callData[fig.dataset.call];
          const box = fig.querySelector('.fw-run-box');
          if (!d || !d.utterances) { box.textContent = 'This call did not load.'; return; }
          const from = Number(fig.dataset.from), to = Number(fig.dataset.to);
          const turns = d.utterances.slice(from, to + 1);
          box.innerHTML = '';
          const list = el('div', 'fw-turns');
          box.appendChild(list);
          let k = 0;
          const step = () => {
            const t = turns[k % turns.length];
            if (k % turns.length === 0) list.innerHTML = '';
            const b = el('div', 'fw-turn is-' + (t.who === 'agent' ? 'agent' : 'user'));
            const who = el('b', '');
            who.textContent = t.who === 'agent' ? 'Agent' : 'Caller';
            const tx = el('span', '');
            tx.textContent = String(t.text).replace(/###STOP###/g, '').trim();
            b.append(who, tx);
            list.appendChild(b);
            list.scrollTop = list.scrollHeight;
            k++;
            // The real gap between these two turns, compressed 6x and floored, so the
            // rhythm is the call's own rather than a fixed tick.
            const nxt = turns[k % turns.length];
            const gap = (k % turns.length === 0) ? 2600
              : Math.max(1400, Math.min(4200, ((nxt.s - t.s) || 4) * 1000 / 6 + 1200));
            callTimers.push(setTimeout(step, gap));
          };
          step();
        });
      });
    });
  }

  function unmountRuns(except) {
    runStops.forEach((rs) => {
      if (rs.i === except) return;
      rs.grid.querySelectorAll('.fw-run').forEach((fig) => {
        const k = fig.dataset.key;
        if (k && mapLive[k]) {
          const inst = mapLive[k];
          delete mapLive[k];
          try { inst.destroy(); } catch (e) { /* gone */ }
        }
        const box = fig.querySelector('.fw-run-box');
        if (box) {
          box.innerHTML = '';
          const wait = el('div', 'fw-map-wait');
          wait.textContent = 'loading';
          box.appendChild(wait);
        }
      });
    });
    if (except === -1) stopCalls();
  }

  function runsOnStopChange(stop) {
    if (!runStops.length) return;
    const near = runStops.find((rs) => Math.abs(rs.i - stop) <= 1);
    unmountRuns(near ? near.i : -1);
    if (near) mountRuns(near.i);
  }

  // ---------------------------------------------------------------- geometry
  // Each section owns a band of scroll measured in viewport heights. Its camera
  // keyframe sits at the CENTRE of its band, and the camera interpolates between
  // consecutive centres. That is what makes the whole page one continuous move
  // instead of a sequence of slides: there is no moment when nothing is moving
  // except the deliberate settle inside a band.
  const bands = S.map((s) => s.scroll || 1.25);
  const bandSum = bands.reduce((a, b) => a + b, 0);
  function vh() { return window.innerHeight; }
  function vw() { return window.innerWidth; }
  // Every one of these is constant between resizes, and paintCopy used to recompute
  // centrePx(i) inside its own loop - a quadratic pile of additions plus an innerHeight read
  // per section, every animation frame. Cached in measure(), which layout() calls.
  let centres = [];
  let total = 0;
  function measure() {
    const H = vh();
    // The opening is in flow, so it occupies real document height ABOVE the flight. Every
    // centre has to move down by exactly that much or the first stop lands underneath it.
    const openPx = openEl ? openEl.offsetHeight : 0;
    const lead = ((VID && VID.lead) || 0) * H + openPx;
    total = bandSum * H + lead;
    let acc = 0;
    centres = bands.map((b) => {
      // Every stop shifts down by the lead, so the gaps BETWEEN stops - which is what sets
      // each leg's pacing - are untouched by it.
      const c = (acc + b / 2) * H + lead;
      acc += b;
      return c;
    });
  }
  measure();
  function totalPx() { return total; }
  function centrePx(i) { return centres[i]; }

  // The copy band has to fit the TALLEST panel, because all five are stacked in one grid
  // cell. A fixed reserve cannot do this: panel height grows as the window narrows and
  // titles rewrap, and again if the reader enlarges text. Measured at 1366x768 the tallest
  // panel wanted 355px against a 278px band and the primary CTA was silently clipped by a
  // stage that is overflow:hidden. So measure, then give the film whatever is left.
  // One film height per stop, not one for the whole page. Sizing everything from the tallest
  // panel meant the shortest stop paid for the longest one: the opening and closing statements
  // are a third the height of a pair stop, and their film was held small for no reason.
  let filmPx = [];

  function fitFilm() {
    if (SHELL !== 'stacked') return;
    // This has to iterate. The copy band's width is bound to the film's width so the two
    // share an outer edge, which means panel height depends on film size, which depends on
    // panel height. One pass settles wherever it happens to land; three converge.
    // The band's own top and bottom padding, read rather than remembered. It is a clamp on
    // vh in the sheet, so the constant 46 that used to stand here was wrong at both ends:
    // it over-reserved by 11px on a 768px laptop and UNDER-reserved by 6px above about
    // 1100px tall, which is the exact clipping this function exists to prevent.
    const cs = getComputedStyle(copyWrap);
    const PAD = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    let px = 0;
    for (let pass = 0; pass < 3; pass++) {
      let tallest = 0;
      const heights = [];
      panels.forEach((p) => {
        const wasHidden = p.hidden;
        const wasOpacity = p.style.opacity;
        p.hidden = false;
        p.style.opacity = '0';         // measurable, never a visible flash
        heights.push(p.scrollHeight);
        tallest = Math.max(tallest, p.scrollHeight);
        p.hidden = wasHidden;
        p.style.opacity = wasOpacity;
      });
      // Per panel, measured in the same pass. The ceiling is higher than the shared value so
      // a short stop genuinely opens up rather than merely matching the crowd.
      filmPx = heights.map((hh) =>
        Math.round(Math.max(vh() * 0.22, Math.min(vh() * 0.74, vh() - (hh + PAD)))));
      const want = Math.min(vh() * 0.6, vh() - (tallest + PAD));
      // Floor at 30vh: past that the film is too small to be worth showing, and the honest
      // answer is shorter copy rather than a postage stamp.
      const next = Math.round(Math.max(vh() * 0.22, want));
      if (Math.abs(next - px) < 2) break;
      px = next;
      document.documentElement.style.setProperty('--film', px + 'px');
    }
    // Land on the CURRENT stop's own value here rather than leaving the tallest-panel value
    // for paintCopy to replace on the next stop change. Writing it later is a layout shift
    // measured at CLS 0.15 on first paint, over the 0.1 threshold.
    if (filmPx[liveStop]) {
      document.documentElement.style.setProperty('--film', filmPx[liveStop] + 'px');
      root.dataset.stop = String(liveStop);
    }
  }

  // 100vw includes the classic scrollbar; documentElement.clientWidth does not. Every width
  // in the sheet derived from raw 100vw was therefore up to 15px too wide, which at 430px
  // put the film at x = -7 with both edges clipped by the stage. Published as --sbw so the
  // sheet can subtract it. It has to be read AFTER the spacer has its height, or the page
  // is not yet long enough to have a scrollbar and the answer is always zero.
  function syncScrollbar() {
    const w = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    if (w !== lastSbw) {
      lastSbw = w;
      document.documentElement.style.setProperty('--sbw', w + 'px');
    }
  }

  // The film's real painted box, published for the sheets.
  //
  // The name plate has to sit against the picture, and the picture is not a fixed size or a
  // fixed place: fitFilm gives each stop its own height, and each shell positions it
  // differently. Anchored to the stage instead, the plate sat at the bottom of the window
  // while the film floated in the middle of it, and the two read as unrelated. There is no
  // way to express "under the film" in the sheet alone, so the measurement is published.
  // The keynote matrix leaves a hole in its middle cell and the film has to sit in it
  // exactly. There is no way to say "be that cell" in the sheet - the cell is in the copy
  // column and the film is in the stage - so the cell is measured and published.
  let lastHole = '';
  function publishHole() {
    const h = copyWrap.querySelector('.fw-panel.is-live .fw-sum-hole');
    if (!h) return;
    const b = h.getBoundingClientRect();
    if (!b.width) return;
    const key = [b.x, b.y, b.width, b.height].map(Math.round).join(',');
    if (key === lastHole) return;
    lastHole = key;
    const st = document.documentElement.style;
    st.setProperty('--hole-x', Math.round(b.x + b.width / 2) + 'px');
    st.setProperty('--hole-y', Math.round(b.y + b.height / 2) + 'px');
    st.setProperty('--hole-w', Math.round(b.width) + 'px');
    st.setProperty('--hole-h', Math.round(b.height) + 'px');
  }

  let lastBox = '';
  function publishFilmBox() {
    const e = videoEl && !videoEl.hidden ? videoEl : heroImg;
    if (!e) return;
    const b = e.getBoundingClientRect();
    if (!b.width) return;
    const key = Math.round(b.x) + ',' + Math.round(b.y) + ',' +
                Math.round(b.width) + ',' + Math.round(b.height);
    if (key === lastBox) return;               // per-frame writes would relayout constantly
    lastBox = key;
    const st = document.documentElement.style;
    st.setProperty('--film-x', Math.round(b.x) + 'px');
    st.setProperty('--film-y', Math.round(b.y) + 'px');
    st.setProperty('--film-w2', Math.round(b.width) + 'px');
    st.setProperty('--film-h2', Math.round(b.height) + 'px');
    st.setProperty('--film-bot', Math.round(b.bottom) + 'px');
  }

  function layout() {
    measure();
    spacer.style.height = totalPx() + 'px';
    syncScrollbar();
    fitFilm();
    publishHole();
    publishFilmBox();
    // fitFilm leaves --film at the TALLEST panel's value. paintCopy only replaces it with
    // this stop's own value when the stop index changes, so after a resize - where the stop
    // has not changed - the per-stop size was never restored and the film stayed shrunk to
    // fit a panel that is not on screen. Forgetting the index makes the next frame reapply.
    delete root.dataset.stop;
    // Stops are a fraction of a spacer that just changed height, so restore the reader's
    // place rather than letting them slide through the story. `instant` matters: the sheet
    // sets scroll-behavior:smooth on <html>, which would turn this into an animation and
    // then let the second frame() read a position the scroll has not reached yet.
    restoring = true;
    // Not on the first call. lastFrac is 0 until a frame has run, and the browser restores
    // the scroll position of a reloaded page on its own - so restoring here would drag a
    // reader who reloaded mid-flight back to the opening dome.
    if (!firstLayout) {
      window.scrollTo({ top: Math.max(0, lastFrac * totalPx() - vh() / 2), behavior: 'instant' });
    }
    firstLayout = false;
    frame(true);
    restoring = false;
  }

  // ---------------------------------------------------------------- camera
  const smooth = (t) => t * t * (3 - 2 * t);

  // `linger` remaps progress within a leg so the camera settles as it arrives and
  // picks up again on the way out, which is when the copy is meant to be read.
  // Endpoints are untouched, so it can never desynchronise the chain.
  function lingered(t, amt) {
    if (!amt) return t;
    const s = smooth(t);
    return t + (s - t) * Math.min(0.85, amt);
  }

  // One number per section, interpolated across the same bands the camera uses, so anything
  // driven by it moves with the flight instead of snapping at a stop boundary. The mark's
  // growth is the only user today; keeping it general is what stops the next one becoming a
  // second, differently-eased timeline that drifts out of agreement with this one.
  function scalarAt(pos, key, dflt) {
    const v = (i) => (typeof S[i][key] === 'number' ? S[i][key] : dflt);
    if (pos <= centrePx(0)) return v(0);
    if (pos >= centrePx(N - 1)) return v(N - 1);
    let i = 0;
    while (i < N - 2 && pos > centrePx(i + 1)) i++;
    const a = centrePx(i), b = centrePx(i + 1);
    return v(i) + (v(i + 1) - v(i)) * smooth((pos - a) / (b - a));
  }

  function cameraAt(pos) {
    // pos is the scroll position of the viewport centre, in px.
    if (pos <= centrePx(0)) return { ...S[0].cam, i: 0, f: 0 };
    if (pos >= centrePx(N - 1)) return { ...S[N - 1].cam, i: N - 1, f: 0 };
    let i = 0;
    while (i < N - 2 && pos > centrePx(i + 1)) i++;
    const a = centrePx(i), b = centrePx(i + 1);
    const raw = (pos - a) / (b - a);
    const t = lingered(smooth(raw), (S[i].linger || 0) * 0.5 + (S[i + 1].linger || 0) * 0.5);
    const c0 = S[i].cam, c1 = S[i + 1].cam;
    return {
      x: c0.x + (c1.x - c0.x) * t,
      y: c0.y + (c1.y - c0.y) * t,
      // Zoom interpolates geometrically. A linear blend between 1.0 and 2.8 spends
      // most of its time already zoomed in and reads as a lurch on the way out.
      z: Math.exp(Math.log(c0.z) + (Math.log(c1.z) - Math.log(c0.z)) * t),
      i, f: raw,
    };
  }

  // ---------------------------------------------------------------- frame
  let cur = null;             // the smoothed camera actually drawn
  let target = null;
  let raf = 0;

  function focal() {
    // Where in the viewport the camera's target point sits. On a wide screen the
    // copy occupies the right, so the subject is offset left of centre; on a
    // narrow screen the copy sits below and the subject rides high.
    // Copy sits in a band along the bottom, so the subject centres horizontally and
    // rides above it rather than being pushed off to one side.
    return vw() > 900 ? { x: 0.50, y: 0.42 } : { x: 0.50, y: 0.36 };
  }

  function draw(cam) {
    const H0 = Math.min(vh() * 0.88, vw() * 0.88 / ASPECT);
    const H = H0 * cam.z;
    const W = H * ASPECT;
    const f = focal();
    const left = vw() * f.x - cam.x * W;
    const top = vh() * f.y - cam.y * H;
    heroImg.style.width = W + 'px';
    heroImg.style.height = H + 'px';
    heroImg.style.transform = `translate3d(${left}px, ${top}px, 0)`;

    // Push-in softens and darkens the backdrop. This is the honest handling of a
    // flat source: the deeper the dolly, the more the pixels are being stretched,
    // so that is exactly where the sharp foreground globe takes over.
    const depth = Math.max(0, Math.min(1, (cam.z - 1) / 1.9));
    heroImg.style.filter = reduce ? 'none' : `blur(${(depth * 7).toFixed(2)}px) saturate(${1 - depth * 0.28})`;
    veil.style.opacity = (depth * 0.66).toFixed(3);
    // Light on the wide shot so the world stays open, heavier once pushed in, which is
    // both when the copy is longest and when the backdrop behind it is brightest.
    scrim.style.opacity = (0.5 + depth * 0.5).toFixed(3);
  }

  // ---------------------------------------------------------------- ground match
  // The film's floor is not one colour. Measured off flight.mp4's own border pixels it runs
  // #e6e5e6 at the opening, #f5f2f1 at the third stop and #fefefe at the close, against a
  // page floor fixed at #e8e9e7 - a 22-level seam, and it lands on the closing stop, which
  // is exactly where the reader stops moving and looks. Nothing in a stylesheet can match a
  // moving target, so the page takes its floor from the frame that is actually on screen.
  //
  // The sample is the frame's BORDER ring, not its average: the middle is the subject and
  // averaging it in would drag the page grey every time a dark globe fills the shot.
  const GS = 40;                              // samples along each edge
  let gcan = null, gctx = null;
  let ground = null;                          // the eased colour currently written
  let groundAt = 0;

  function sampleGround() {
    if (!videoEl || !videoOK || videoEl.readyState < 2) return null;
    const VW = videoEl.videoWidth, VH = videoEl.videoHeight;
    if (!VW || !VH) return null;
    if (!gcan) {
      gcan = document.createElement('canvas');
      gcan.width = GS; gcan.height = 4;
      gctx = gcan.getContext('2d', { willReadFrequently: true });
    }
    // Four SOURCE strips, one per edge, each scaled to a single row.
    //
    // Not one downscale of the whole frame. Drawing 1920x1080 into a small square makes each
    // destination pixel the average of a 60x60 source block, so an "edge" sample is really
    // 60px of frame - and at the third stop that reaches into a dark globe and dragged the
    // page floor to rgb(204,202,206) against a measured border of #e6e6e4. Source rectangles
    // sample the actual border, which is what has to match the page.
    const T = Math.max(2, Math.round(VH * 0.012));     // a ~1.2% band, thin but not noisy
    try {
      gctx.drawImage(videoEl, 0, 0, VW, T, 0, 0, GS, 1);                 // top
      gctx.drawImage(videoEl, 0, VH - T, VW, T, 0, 1, GS, 1);            // bottom
      gctx.drawImage(videoEl, 0, 0, T, VH, 0, 2, 1, 1);                  // left
      gctx.drawImage(videoEl, VW - T, 0, T, VH, 1, 2, 1, 1);             // right
    } catch (e) {
      return null;                            // a frame not yet decoded
    }
    let d;
    try {
      d = gctx.getImageData(0, 0, GS, 4).data;
    } catch (e) {
      return null;                            // a tainted canvas
    }
    const px = [];
    const take = (x, y) => {
      const k = (y * GS + x) * 4;
      px.push([d[k], d[k + 1], d[k + 2]]);
    };
    for (let x = 0; x < GS; x++) { take(x, 0); take(x, 1); }
    take(0, 2); take(1, 2);
    if (!px.length) return null;
    // The FLOOR, not the mean. The mean is not the floor whenever the subject touches an
    // edge, and at the third stop the dome does: measured, the border mean there is
    // rgb(206,203,208) against a floor of rgb(236,236,233), so a page tracking the mean
    // turned mid-grey. Sorting by luminance and taking the 50th to 90th percentile drops
    // the subject at the bottom and any specular highlight at the top; measured across all
    // five filmed stops that band lands on the studio floor every time.
    px.sort((a, b2) => (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2])
                     - (0.299 * b2[0] + 0.587 * b2[1] + 0.114 * b2[2]));
    const lo = Math.floor(px.length * 0.50), hi = Math.max(lo + 1, Math.floor(px.length * 0.90));
    let r = 0, g = 0, b = 0;
    for (let i = lo; i < hi; i++) { r += px[i][0]; g += px[i][1]; b += px[i][2]; }
    const n = hi - lo;
    return [r / n, g / n, b / n];
  }

  const BASE_GROUND = (function () {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim();
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [232, 233, 231];
  })();

  let lastSample = null;
  let groundWritten = false;
  let groundDirty = true;

  function syncGround(filmVis, now) {
    // Sampling every frame is wasted work - the floor of a clay render moves over seconds,
    // not over 16 ms - and getImageData is the one call here that can stall a frame. So it
    // is throttled, but `groundDirty` overrides the throttle: a seek means the frame under
    // the sample has changed, and a throttle alone will park before it notices.
    let want = BASE_GROUND;
    let pending = false;
    if (filmVis > 0.5) {
      if (groundDirty || now - groundAt > 90) {
        groundAt = now;
        const s = sampleGround();
        if (s) { lastSample = s; groundDirty = false; }
      }
      // Still waiting on a decodable frame. Reported as movement so the chain stays alive
      // rather than parking on a colour taken from a frame that is no longer up.
      pending = groundDirty;
      if (lastSample) want = lastSample;
    }
    if (!ground) ground = want.slice();
    // Eased, not written: a cut between two near-whites is more visible than the seam it is
    // there to remove, because the eye catches the whole page changing at once.
    const k = reduce ? 1 : 0.12;
    let moved = false;
    for (let c = 0; c < 3; c++) {
      const d = want[c] - ground[c];
      if (Math.abs(d) > 0.4) moved = true;
      ground[c] += d * k;
    }
    if (moved || !groundWritten) {
      groundWritten = true;
      document.documentElement.style.setProperty('--bg',
        'rgb(' + ground.map((c) => Math.round(c)).join(',') + ')');
    }
    return moved || pending;
  }
  let liveStop = 0;
  let liveStep = 0;
  let sayT = 0;
  let filmVis = 0;

  function paintCopy(pos) {
    let nearD = Infinity, nearI = liveStop;
    const vises = [];
    // Hoisted. innerHeight was being read once per section, every frame, after `centres`
    // was cached for exactly that reason.
    const H = vh();
    // How much of each stage layer is wanted right now. Taken from the panels' own fade
    // curve rather than from a second one, so a layer is never still up under copy that has
    // gone, and never absent under copy that is fully lit.
    const roleVis = { logo: 0, film: 0, art: 0, none: 0 };
    for (let i = 0; i < N; i++) {
      const s = S[i];
      const c = centrePx(i);
      const half = bands[i] * H * 0.5;
      const d = Math.abs(pos - c) / half;            // 0 at the stop, 1 at the band edge
      // HOLD, then a short dissolve. Not a curve that starts falling immediately.
      //
      // `d` is 0 at the stop and 1 at the band edge. The previous shape held full strength
      // only to d = 0.12 and then decayed the whole rest of the way, so a reader spent
      // about 12% of each band looking at fully-lit text and the other 88% watching it
      // fade - which is what "the scroll fade is too much, the text is barely visible"
      // describes. Now it is the other way round: solid to d = 0.70, which is 70% of the
      // band, and the dissolve happens in the last 30%.
      //
      // END > 1 on purpose. At exactly 1 the two neighbouring bands would meet at zero and
      // the screen would go blank between every pair of stops - eleven windows and 10.6% of
      // the page, measured, before this was found. Overlapping them means the outgoing and
      // incoming panels cross at half strength instead, which is a dissolve rather than a
      // cut, and the film underneath never blinks.
      // END 1.12, not 1.30. At 1.30 two panels crossed at half strength each and the
      // handover read as double-exposed text - two paragraphs superimposed. They can cross
      // much lighter now WITHOUT the screen emptying, because the film no longer rides this
      // curve: it holds at full opacity across the whole filmed span, so there is always a
      // picture there even at the instant the text is changing over.
      const HOLD = 0.70, END = 1.12;
      let vis = d <= HOLD ? 1 : 1 - smooth(Math.min(1, (d - HOLD) / (END - HOLD)));
      // The opening statement does not fade IN. At scrollY = 0 the reader is a full band
      // above the first stop, so the curve above put the page's own headline on screen at
      // 0.175 opacity - 1.44:1 against the ground, and a ghost-grey first impression. It
      // fades out normally once the camera is past it; only the approach is floored.
      if (i === 0 && pos <= c) vis = 1;
      vises[i] = vis;
      roleVis[roleOf(s)] = Math.max(roleVis[roleOf(s)], vis);
      // Each world name rides its own section's curve, so consecutive world stops dissolve
      // into one another instead of swapping in a frame. The slide is the same 34px the
      // copy panel opposite uses, in the same direction, so the two halves move together.
      if (marks[i]) {
        marks[i].style.opacity = vis.toFixed(3);
        marks[i].style.transform = reduce ? 'none'
          : `translate3d(0, ${((1 - vis) * (pos > c ? -34 : 34)).toFixed(1)}px, 0)`;
        marks[i].hidden = vis <= 0.004;
      }
      const p = panels[i];
      p.style.opacity = vis.toFixed(3);
      // Published so anything inside the panel that wants to arrive WITH the scroll can,
      // instead of firing a wall-clock transition on arrival. Eased past the halfway point
      // so a chart is at full length by the time the panel is fully lit rather than still
      // filling as it starts to leave.
      p.style.setProperty('--grow', Math.min(1, vis * 1.9).toFixed(3));
      p.style.transform = reduce ? 'none'
        : `translate3d(0, ${((1 - vis) * (pos > c ? -34 : 34)).toFixed(1)}px, 0)`;
      // Operable exactly as long as it is legible. These used to be two different
      // thresholds - inert below 0.55, painted until 0.002 - which left a wide band where a
      // sighted reader could see a perfectly readable "Project page" button, click straight
      // through it, and get nothing, while assistive technology could not see it at all.
      const live = vis > 0.14;
      p.style.pointerEvents = live ? 'auto' : 'none';
      p.inert = !live;
      // If focus was inside a panel that just went dead, park it on that panel's rail dot
      // rather than letting the browser drop it to <body> with no announcement.
      if (!live && p.contains(document.activeElement)) dots[i].focus();
      p.hidden = vis <= 0.002;

      // In video mode the chain already shows each globe full-frame, so the floating
      // tile would be the same object twice on screen.
      const tile = videoOK ? null : tiles[i];
      if (tile) {
        // The globe rises into place and settles, then sinks as the camera leaves.
        const tv = Math.max(0, 1 - Math.pow(Math.max(0, d - 0.05) / 0.85, 1.6));
        tile.style.opacity = tv.toFixed(3);
        const rise = (1 - tv) * 40;
        const sc = 0.86 + tv * 0.14;
        tile.style.transform =
          `translate3d(-50%, calc(-50% + ${rise.toFixed(1)}px), 0) scale(${sc.toFixed(3)})`;
        tile.hidden = tv <= 0.002;
      }
      globes.forEach((g) => {
        if (g.__stop !== i) return;
        // Only on a change. Writing aria-current eighteen times a frame to set it to the
        // value it already had was 17 setAttribute calls per frame for nothing.
        const on = d < 0.5;
        if (g.classList.contains('is-on') !== on) {
          g.classList.toggle('is-on', on);
          g.setAttribute('aria-current', on ? 'true' : 'false');
        }
      });
      // NEAREST, not "inside a half-band". The two used to be the same test, and it
      // capped the reveal at a quarter of the band: the ramp could only run while d < 0.5,
      // and it had to finish AT the stop or a rail click landed part-way through it and
      // hid half the evidence. Tracking the nearest section instead frees the ramp to start
      // as soon as this stop is the one being approached, so four steps get 42% of the band
      // rather than 25% and still complete on arrival.
      if (d < nearD) { nearD = d; nearI = i; }
      const dotOn = d < 0.5;
      if (dots[i].classList.contains('is-on') !== dotOn) {
        dots[i].classList.toggle('is-on', dotOn);
        dots[i].setAttribute('aria-current', dotOn ? 'true' : 'false');
      }
    }
    // The live stop, and how far into its staged reveal the reader has come.
    liveStop = nearI;
    {
      const s = S[liveStop], c = centrePx(liveStop), half = bands[liveStop] * H * 0.5;
      const steps = s.steps || 0;
      if (steps > 1) {
        const raw = Math.max(0, Math.min(1, (pos - (c - half)) / (half * 2)));
        // Over the approach, raw 0.08 to 0.50, so the last step lands exactly on the stop
        // and holds through it. Both bounds have been wrong before, in opposite ways:
        // centred, the stop itself sat on step 2 of 4 and anyone arriving by a rail dot saw
        // three of the six walks with no sign the rest existed; run past the stop, the same
        // thing happened again from the other side.
        const p = Math.max(0, Math.min(0.999, (raw - 0.08) / 0.42));
        liveStep = Math.min(steps - 1, Math.floor(p * steps));
      } else {
        liveStep = 0;
      }
    }

    if (root.dataset.block === 'summary') publishHole();
    if (navItems.length && openEl) {
      const past = pos - vh() / 2 > openEl.offsetHeight * 0.55;
      if (root.dataset.past !== String(past)) {
        root.dataset.past = String(past);
        navItems.forEach((b) => {
          const on = past && liveStop >= b.__from && liveStop <= b.__to;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-current', on ? 'true' : 'false');
        });
      }
    }

    // The stage layers. `hidden` below a hair of opacity rather than merely transparent: a
    // 39 MB video left painted under a stop that does not use it still costs a composite and
    // a decode every frame, and the mark's text would still be found by a page search.
    const layer = (node, v) => {
      node.style.opacity = v.toFixed(3);
      node.hidden = v <= 0.004;
    };
    layer(logoWrap, roleVis.logo);
    artImgs.forEach((im, k) => { if (im) layer(im, vises[k]); });
    // The film HOLDS across the whole filmed span rather than riding each section's fade.
    // Taking the max of the per-section curves meant it dipped between every pair of filmed
    // stops, so the one element that is meant to be continuous was the one blinking. It
    // ramps only at the two ends, where there genuinely is no film to show.
    if (FILMED.length) {
      const fi = FILMED[0], li = FILMED[FILMED.length - 1];
      const first = centrePx(fi), last = centrePx(li);
      const half = H * 0.5;
      // The ramp is only for film that has to appear from somewhere. When the FIRST section
      // is itself filmed there is nothing before it to appear from, and ramping anyway put
      // the picture at 19% opacity at the very top of the page - the one frame every reader
      // sees first. Same at the other end.
      roleVis.film =
        (pos >= first || fi === 0) && (pos <= last || li === N - 1) ? 1
        : Math.max(0, 1 - (pos < first ? (first - pos) : (pos - last)) / Math.max(1, half * 1.6));
    }
    // A section that asks for NO backdrop suppresses whatever the neighbours would have
    // put there. Without this the film kept whatever opacity the next stop's fade gave it
    // and was painted at partial strength behind the opening matrix - a diorama printed
    // through the abstract.
    const off = Math.max(roleVis.none, roleVis.art);
    if (off > 0) roleVis.film *= Math.max(0, 1 - off);
    filmVis = roleVis.film;
    // The COMPUTED backdrop obeys the stage roles too. It only ever needed to in the export,
    // where the film config is stripped and this is the backdrop - and there it was showing
    // at all twelve stops, including the four that want nothing on the left, because the
    // only rule that hid it was `.fw-has-video .fw-hero`, which never matched without a
    // video. That is why the single-file build had the whole diorama printed under the
    // abstract and under every results table.
    if (heroWanted && !videoOK) {
      heroImg.style.opacity = roleVis.film.toFixed(3);
      heroImg.hidden = roleVis.film <= 0.004;
    }
    if (videoEl) {
      // Not `hidden`. The film has to keep decoding through a stop that does not show it, or
      // the next filmed stop opens on a stale frame while the decoder catches up.
      videoEl.style.opacity = roleVis.film.toFixed(3);
    }
    // The mark's travel from small-and-centred to large-and-left. One number, interpolated
    // over the same bands as everything else; the sheets decide what it means, which is how
    // the stacked shell can decline to move it at all.
    document.documentElement.style.setProperty('--logo-t',
      scalarAt(pos, 'logoT', 1).toFixed(4));

    if (root.dataset.stop !== String(liveStop)) {
      root.dataset.stop = String(liveStop);
      root.dataset.stage = roleOf(S[liveStop]);
      // What KIND of evidence this stop carries, so the sheets can budget space for it.
      // The stage role says what is on the left; this says what is on the right, and they
      // are not the same question: three stops share stage "film" and want three different
      // splits, because six live maps need room a paragraph does not.
      // An explicit `block` wins: the closing stop has no content to classify by, and it is
      // the one stop whose layout is different from every other.
      root.dataset.block = S[liveStop].block ? S[liveStop].block
        : S[liveStop].summary ? 'summary'
        : S[liveStop].runs ? 'runs'
        : S[liveStop].maps ? 'maps'
        : S[liveStop].pillars ? 'table'
        : S[liveStop].bars ? 'bars' : 'text';
      // Marks the panel the flight has actually arrived at, which is what the bars grow
      // from. Set here rather than in the per-section loop: that runs every frame, and
      // writing a class thirteen times a frame to change nothing is how a scroll page ends
      // up dropping them.
      panels.forEach((pp, k) => pp.classList.toggle('is-live', k === liveStop));
      // Nothing is current while the opening is still the screen: it is not a section, and
      // lighting the first entry there tells the reader they are somewhere they are not.
      const past = !openEl || window.scrollY > openEl.offsetHeight * 0.55;
      navItems.forEach((b) => {
        const on = past && liveStop >= b.__from && liveStop <= b.__to;
        if (b.classList.contains('is-on') !== on) {
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-current', on ? 'true' : 'false');
        }
      });
      // Unconditionally, including the very first paint: a reader who reloads part-way down
      // is restored by the browser straight onto whatever stop they were on, and skipping
      // this on the first frame would leave that stop's walks permanently empty.
      mapsOnStopChange(liveStop);
      runsOnStopChange(liveStop);
      // Only on a stop change: writing this every frame would relayout the film continuously.
      if (SHELL === 'stacked' && filmPx[liveStop]) {
        document.documentElement.style.setProperty('--film', filmPx[liveStop] + 'px');
      }
      // The film's box can change with the stop - the split shell widens it at a table stop
      // - so the plate's anchor has to be re-read. After a frame, so the new width is the
      // one that gets measured rather than the one being replaced.
      requestAnimationFrame(() => { publishHole(); publishFilmBox(); });
      // All five panels share one grid cell in one scroll container, so a column that had to
      // scroll at the previous stop hands its offset to the next one, which then opens
      // part-way down its own copy.
      if (copyWrap.scrollTop) copyWrap.scrollTop = 0;
      // Debounced. `polite` QUEUES, so a two-second fling down the page enqueued all
      // twelve labels and the reader heard them minutes behind their own scrolling.
      // Announced only once the flight has actually settled somewhere.
      clearTimeout(sayT);
      sayT = setTimeout(() => {
        status.textContent = (S[liveStop] && S[liveStop].label) || '';
      }, 450);
    }
    if (root.dataset.step !== String(liveStep)) root.dataset.step = String(liveStep);
    hint.style.opacity = pos < H * 0.75 ? '1' : '0';
  }

  // Scroll position -> a time in the rendered chain. Same band/centre geometry as
  // cameraAt, so a stop lands on its clip's tight shot and the space between two stops
  // plays the connector that was rendered for exactly that pair.
  // The sections that are actually filmed, in order. Everything below walks THIS list rather
  // than the section list, so an unfilmed stop between two filmed ones simply lengthens the
  // leg that spans it instead of demanding a frame nobody rendered.
  const FILMED = VID ? VID.stops.map((t, i) => i).filter((i) => VID.stops[i] !== null &&
                                                               VID.stops[i] !== undefined) : [];

  function timeAt(pos) {
    const T = VID.stops;
    const F = FILMED;
    const last = F[F.length - 1];
    if (pos >= centrePx(last)) return T[last];
    if (pos <= centrePx(F[0])) {
      // Lead-in: ease from the first frame of the film up to the first filmed stop, rather
      // than freezing on it. Scroll does something immediately.
      const head = centrePx(F[0]) - vh() / 2;   // scroll distance to the first filmed stop
      if (head <= 0) return T[F[0]];
      const k = Math.max(0, Math.min(1, (pos - vh() / 2) / head));
      return T[F[0]] * k;
    }
    let k = 0;
    while (k < F.length - 2 && pos > centrePx(F[k + 1])) k++;
    const i = F[k], j = F[k + 1];
    const a = centrePx(i), b = centrePx(j);
    const raw = (pos - a) / (b - a);
    if (reduce) return T[raw < 0.5 ? i : j];
    // `linger` was being honoured by the computed camera and silently ignored here, so the
    // one knob meant for holding a stop did nothing on the page people actually see.
    // `lingered` applies smoothstep itself, so passing it smooth(raw) eased the film TWICE
    // and the within-leg speed swung about 20 to 1 - measured peak/average 1.8 against the
    // 1.5 a single smoothstep gives. A hold is right for the camera, where settling on a
    // subject is the point; on currentTime a hold is a frozen frame followed by a sprint.
    let t = lingered(raw, (S[i].linger || 0) * 0.5 + (S[j].linger || 0) * 0.5);
    // `pace` reshapes how film time is spent ACROSS a leg, which linger cannot do: linger
    // slows both ends symmetrically, pace decides whether the seconds go to the beginning
    // of the shot or the end. Above 1 the film crawls early and catches up late, which is
    // what an establishing shot needs - the subject is only on screen for the first tenth
    // of the leg, so an even spend blows past it in two wheel notches.
    const pace = S[i].pace || 1;
    if (pace !== 1) t = Math.pow(t, pace);
    // Opening leg only. smoothstep is flat at both ends and pace exaggerates it, which at
    // the top of the page reads as the thing having hung. The domain legs are left exactly
    // as they are - their pacing is right and a global floor would speed all of them up.
    if (k === 0) {
      const FLOOR = 0.25;
      t = FLOOR * raw + (1 - FLOOR) * t;
    }
    return T[i] + (T[j] - T[i]) * t;
  }

  let curT = null;
  let seekBusy = false;
  let seekQueued = null;
  let seekAt = 0;
  let lastWritten = null;

  function drawVideo(pos, instant) {
    const want = timeAt(pos);
    if (!Number.isFinite(want)) return false;
    // Follow rather than snap, for the same reason the camera does: wheel deltas are
    // coarse and writing them straight to currentTime reads as a stutter.
    curT = (!Number.isFinite(curT) || reduce || instant) ? want : curT + (want - curT) * 0.22;
    // Sub-frame writes are wasted work - the decoder cannot show them and each seek
    // costs. One frame at 24fps is ~0.042s.
    // A seek that neither completes nor errors - a stalled blob read, a superseded range
    // request, a target past duration - would otherwise hold the latch for ever, and from
    // then on every write is merely queued: the film freezes on its last frame while the
    // copy carries on painting, with nothing in the console. 35 aborted media reads were
    // measured during one backward pass, which is exactly that class of event.
    if (seekBusy && (!videoEl.seeking || performance.now() - seekAt > 500)) seekBusy = false;
    if (lastWritten === null || Math.abs(curT - lastWritten) > 0.02) {
      lastWritten = curT;
      if (seekBusy) {
        seekQueued = curT;             // coalesce: only the newest target matters
      } else {
        seekBusy = true;
        seekAt = performance.now();
        try { videoEl.currentTime = curT; } catch (e) { seekBusy = false; }
      }
    }
    return Math.abs(want - curT) > 0.01;
  }

  let lastFrac = 0;
  let restoring = false;
  let firstLayout = true;
  let lastSbw = -1;

  function frame(instant) {
    // Cancel any callback already scheduled. Assigning `raf = 0` on the way out is not
    // enough: a callback can still be pending at that moment, and onScroll only tests
    // `if (!raf)`, so a second chain could start and both would then run every frame, each
    // writing currentTime and repainting the copy.
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const pos = window.scrollY + vh() / 2;
    // Where the reader is in the story, as a fraction, so a resize can put them back.
    if (!restoring) lastFrac = pos / Math.max(1, totalPx());

    if (videoOK) {
      const moving = drawVideo(pos, instant);
      paintCopy(pos);
      // The ground keeps the chain alive on its own: it eases over about half a second, and
      // parking the loop the instant the film stops seeking would freeze it part-way there,
      // leaving a page floor that is neither the film's nor the sheet's.
      const settling = syncGround(filmVis, performance.now());
      raf = ((moving || settling) && !instant && !reduce)
        ? requestAnimationFrame(() => { raf = 0; frame(false); }) : 0;
      return;
    }

    target = cameraAt(pos);
    if (!cur || instant || reduce) {
      cur = { ...target };
    } else {
      // A light exponential follow. Scroll wheels arrive in coarse steps; without
      // this the camera steps with them instead of gliding.
      const k = 0.18;
      cur.x += (target.x - cur.x) * k;
      cur.y += (target.y - cur.y) * k;
      cur.z += (target.z - cur.z) * k;
    }
    draw(cur);
    paintCopy(pos);
    // Only if the film once drove the floor. On a page that never had one, --bg is whatever
    // the sheet says and writing an identical rgb() over it every frame is pure churn.
    const settling = groundWritten && syncGround(0, performance.now());

    const moving = settling || (!instant && !reduce &&
      (Math.abs(target.x - cur.x) > 1e-4 || Math.abs(target.y - cur.y) > 1e-4 ||
       Math.abs(target.z - cur.z) > 1e-4));
    // The scheduled callback clears `raf` itself. Assigning it here alone meant frame(true)
    // - which layout() and the video error handler both call - could zero it while a
    // callback from onScroll was still pending, so the next scroll event started a SECOND
    // chain and both then ran every frame, each writing currentTime and repainting the copy.
    raf = moving ? requestAnimationFrame(() => { raf = 0; frame(false); }) : 0;
  }

  function onScroll() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; frame(false); });
  }

  // Ignore height-only resizes: on a phone that is just the URL bar collapsing,
  // and relaying out on it makes the page jump under the reader's thumb.
  let lastW = vw();
  function onResize() {
    if (vw() === lastW && matchMedia('(hover: none)').matches) return;
    lastW = vw();
    layout();
  }

  // --------------------------------------------------------------- autoplay
  // Hands-off cinematic mode: the page scrolls itself at a steady rate so the flight can
  // run unattended in a room. It is a real scroll, not a separate animation path, so the
  // camera, the copy, the rail and the world index all stay driven by exactly the same
  // code as a human wheel - there is no second timeline that can drift out of agreement.
  // `?autoplay=1` starts it on load, for leaving the page running in a room unattended.
  const AUTO = Object.assign({ seconds: 105, start: false, loop: true },
                             config.autoplay || {});
  try {
    if (new URLSearchParams(location.search).has('autoplay')) AUTO.start = true;
  } catch (e) { /* file:// with no search is fine */ }
  let auto = false;
  let autoRaf = 0;
  let autoPrev = 0;
  let autoPos = 0;
  let autoHold = 0;

  const autoBtn = el('button', 'fw-auto');
  autoBtn.type = 'button';
  autoBtn.innerHTML = '<span class="fw-auto-icon"></span><span class="fw-auto-text"></span>';
  const autoText = autoBtn.querySelector('.fw-auto-text');

  function autoLabel() {
    autoText.textContent = auto ? 'Pause' : 'Play';
    autoBtn.setAttribute('aria-label', auto ? 'Pause the flight' : 'Play the flight');
    autoBtn.setAttribute('aria-pressed', auto ? 'true' : 'false');
    autoBtn.classList.toggle('is-on', auto);
  }

  function autoStop() {
    if (!auto) return;
    auto = false;
    if (autoRaf) cancelAnimationFrame(autoRaf);
    autoRaf = 0;
    autoLabel();
  }

  function autoStep(ts) {
    if (!auto) return;
    const dt = autoPrev ? Math.min(0.05, (ts - autoPrev) / 1000) : 0;
    autoPrev = ts;
    const end = Math.max(1, totalPx() - vh());
    if (autoHold > 0) {
      // A beat on the closing frame before the rewind, so the last stop is not snatched away.
      autoHold -= dt;
      if (autoHold <= 0) {
        autoPos = 0;
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    } else {
      // Fractional accumulator: at this cadence a frame is well under one pixel, and
      // scrollBy would round every one of them to zero and never move.
      autoPos += (end / AUTO.seconds) * dt;
      if (autoPos >= end) {
        autoPos = end;
        window.scrollTo({ top: end, behavior: 'instant' });
        if (!AUTO.loop) { autoStop(); return; }
        autoHold = 2.2;
      } else {
        // 'instant' is load-bearing: the sheet sets scroll-behavior:smooth on <html>, and a
        // two-argument scrollTo resolves behavior:auto to that CSS value. Every one of these
        // per-frame writes was therefore STARTING a smooth animation and retargeting it on
        // the next frame, so the constant rate the accumulator computes never happened.
        window.scrollTo({ top: autoPos, behavior: 'instant' });
      }
    }
    autoRaf = requestAnimationFrame(autoStep);
  }

  function autoStart() {
    if (auto) return;
    auto = true;
    autoPrev = 0;
    autoHold = 0;
    autoPos = window.scrollY;
    autoLabel();
    autoRaf = requestAnimationFrame(autoStep);
  }

  autoBtn.addEventListener('click', () => (auto ? autoStop() : autoStart()));
  stage.appendChild(autoBtn);
  autoLabel();

  // Any deliberate input takes the wheel back. Scroll itself is NOT in this list, because
  // autoplay scrolls, and listening for it would stop the moment it started.
  ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      // Every event, not just pointerdown. keydown fires before click, so Space or Enter on
      // the focused Pause button stopped playback and then the click handler saw auto=false
      // and started it again; touchstart did the same on a tap. Autoplay was unstoppable by
      // anyone not using a mouse.
      if (autoBtn.contains(e.target)) return;
      autoStop();
    }, { passive: true });
  });

  if (AUTO.start && !reduce) autoStart();

  // ---------------------------------------------------------------- pointer
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches
    || (navigator.maxTouchPoints === 0 && !('ontouchstart' in window));
  if (config.cursor && finePointer && !reduce) {
    const halo = el('div', 'fw-cur fw-cur-halo');
    const core = el('div', 'fw-cur fw-cur-core');
    document.body.append(halo, core);
    root.classList.add('fw-has-cursor');
    let mx = innerWidth / 2, my = innerHeight / 2;
    let hx = mx, hy = my, cx = mx, cy = my;
    let over = false, curRaf = 0;
    const INTERACTIVE = 'a,button,[role="button"]';

    function tick() {
      // Two masses, deliberately different: the core all but keeps up, the halo drifts in
      // behind it. One element lagging alone reads as lag; two at different rates read as
      // something with weight following you.
      cx += (mx - cx) * 0.34;  cy += (my - cy) * 0.34;
      hx += (mx - hx) * 0.11;  hy += (my - hy) * 0.11;
      core.style.transform = `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%)`;
      halo.style.transform =
        `translate3d(${hx}px, ${hy}px, 0) translate(-50%, -50%) scale(${over ? 1.85 : 1})`;
      const settled = Math.hypot(mx - hx, my - hy) < 0.4 && Math.hypot(mx - cx, my - cy) < 0.4;
      curRaf = settled ? 0 : requestAnimationFrame(tick);
    }
    window.addEventListener('pointermove', (e) => {
      mx = e.clientX; my = e.clientY;
      over = !!(e.target && e.target.closest && e.target.closest(INTERACTIVE));
      halo.classList.toggle('is-over', over);
      core.classList.toggle('is-over', over);
      if (!curRaf) curRaf = requestAnimationFrame(tick);
    }, { passive: true });
    window.addEventListener('pointerdown', () => halo.classList.add('is-down'));
    window.addEventListener('pointerup', () => halo.classList.remove('is-down'));
    document.addEventListener('pointerleave', () => {
      halo.style.opacity = '0'; core.style.opacity = '0';
    });
    document.addEventListener('pointerenter', () => {
      halo.style.opacity = ''; core.style.opacity = '';
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(() => { lastW = vw(); layout(); }, 120));

  if (heroWanted && !heroImg.complete) heroImg.addEventListener('load', layout);
  layout();

  return {
    layout,
    goto: (i) => window.scrollTo({ top: centrePx(i) - vh() / 2,
                                  behavior: reduce ? 'instant' : 'smooth' }),
    camera: () => ({ ...cur }),
    stops: N,
  };
}

// A small mark per vendor so the audience can see at a glance which family produced a run.
// Deliberately simplified glyphs, not the vendors' official lockups.
//
// Matched on the system names the paper uses in prose - vendor mark plus version alone -
// rather than on the API identifiers, so "Voice Think Fast" and "3.1-Flash-Live" resolve
// as well as `xai-realtime` and `gemini-3.1-flash-live-preview` do.
/* The vendors' own marks, as shipped in the paper.
   ---------------------------------------------------------------------------
   These were hand-drawn SVGs for a while and every one of them was wrong in a way that
   mattered: OpenAI was a ring with a dot in it, which is a record button, and it was the
   mark on two of the five systems. The real logos are in img/icons and this just picks
   the right file. Returned as markup because that is what the call sites already insert.

   `art:` handles are resolved the same way as every other image on the page, so the
   single-file export works too. */
const VENDOR_ICON = [
  [/nova|sonic|amazon|bedrock/, 'nova'],
  [/gemini|flash-live|google/, 'gemini'],
  [/xai|grok|think fast/, 'grok'],
  [/gpt|openai|realtime/, 'openai'],
];

/* One colour per system, matched on the same loose names vendorMark() matches on, so a
   display name from the paper and an API identifier from a payload both resolve. */
function sysColor(name) {
  const m = String(name).toLowerCase();
  // Gemini is tested BEFORE mini, because "Gemini" contains "mini" and the naive order
  // painted Gemini-3.1-Flash-Live in the mini colour on every chart on the page.
  if (/gemini|flash-live/.test(m)) return 'var(--sys-gem)';
  if (/mini/.test(m)) return 'var(--sys-mini)';
  if (/xai|grok|think fast/.test(m)) return 'var(--sys-vtf)';
  if (/nova|sonic/.test(m)) return 'var(--sys-nova)';
  if (/openai|gpt|realtime/.test(m)) return 'var(--sys-o21)';
  return 'var(--mag)';
}

function vendorMark(model) {
  const m = String(model).toLowerCase();
  if (/not yet|none/.test(m)) {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none"'
      + ' stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2"/></svg>';
  }
  for (const [re, name] of VENDOR_ICON) {
    if (re.test(m)) {
      const path = ICONS[name] || ('img/icons/' + name + '.webp');
      // artSrc() resolves through the export's inlined art table, which does not have to
      // carry every icon. An unresolved lookup returned '' and an <img src=""> is a broken
      // image to the document, so the literal path is the floor.
      const real = artSrc(path)[0] || path;
      return '<img class="fw-vmark" src="' + real + '" alt="" aria-hidden="true">';
    }
  }
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.4"'
    + ' fill="currentColor"/></svg>';
}

/* Set by the page so the export can rewrite these the way it rewrites every other image:
   they are named inside a function rather than in the config, and the build only rewrites
   what it can see in the source. */
const ICONS = (typeof window !== 'undefined' && window.__DW_ICONS) || {};

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

/* Art with a raster fallback behind it.

   Every image on this page is WebP, and a browser that will not decode WebP does not fail
   quietly: Safari paints a question-mark box, so the page reads as broken rather than as
   plain. `make_fallbacks.py` writes a PNG (or, for the opaque poster, a JPEG) beside every
   .webp; this swaps to it on the first error and says so once, because a silent fallback is
   how a whole class of art quietly stops being the art that was designed.

   Deliberately an onerror swap rather than <picture>. <picture> would make the single-file
   export inline BOTH encodings of every image, which is 226 KB of duplicate art in a file
   whose entire reason to exist is that it can be emailed. */
let ART_WARNED = false;

/* `art:A3` -> [data URI, raster fallback data URI].

   The single-file export replaces every `img/x.webp` reference with one of these handles and
   ships one table of the actual bytes, because the same image is named more than once and
   inlining it per mention duplicated 473 KB of base64 into a file whose whole purpose is
   that it can be emailed. It is also the only way the fallback can survive the export: on a
   data: URI the `.webp -> .png` rewrite below matches nothing, so a derived fallback comes
   out identical to the source and the error handler bails on it immediately. */
function artSrc(ref) {
  const t = window.__DW_ART;
  if (!t || typeof ref !== 'string' || ref.slice(0, 4) !== 'art:') return [ref, null];
  const e = t[ref.slice(4)];
  return e ? [e[0], e[1] || null] : [ref, null];
}

function artImg(src, alt, cls) {
  const im = new Image();
  if (cls) im.className = cls;
  im.decoding = 'async';
  im.addEventListener('error', function onFail() {
    const alt2 = im.dataset.fallback;
    if (!alt2 || im.src.endsWith(alt2)) return;   // the fallback failed too; stop here
    if (!ART_WARNED) {
      ART_WARNED = true;
      console.warn('flight: WebP did not decode, falling back to raster art');
    }
    im.src = alt2;
  });
  // Assigned in this order on purpose: alt and the fallback have to be in place before the
  // load can fail, and an <img> that has alt but no src yet is still an image to assistive
  // technology and gets its alt text painted across the stage.
  if (alt !== null && alt !== undefined) im.alt = alt;
  const [real, packed] = artSrc(src);
  if (packed) im.dataset.fallback = packed;
  else if (typeof real === 'string' && /\.webp$/i.test(real)) {
    im.dataset.fallback = real.replace(/\.webp$/i, /poster/i.test(real) ? '.jpg' : '.png');
  }
  if (real) im.src = real;
  return im;
}
