/* nyc_geo walk map - DEMO FORK.
 *
 * This is a copy of src/tau2/visualizer/static/walkmap.js, patched for the standalone
 * Duplex World page. The visualizer's own copy is deliberately untouched, so nothing here
 * can regress the live tool. Every change is tagged DEMO: in a comment.
 *
 * What changed, in one list:
 *   - the payload is passed in rather than fetched, so the page is static;
 *   - the walker GLIDES between corners instead of snapping, and the trail grows with it;
 *   - the transport is an endless rAF loop rather than a one-shot 850 ms setInterval;
 *   - the audio-sync coupling is gone, because there is no audio;
 *   - the field-of-view building highlight is repaired (it iterated the wrong DOM level);
 *   - per-frame cost is cut so the glide holds frame rate.
 *
 * Original header follows.
 *
 * nyc_geo walk map - v2 renderer.
 *
 * Extracted from app.js on purpose (WALKMAP_RENDER_SPEC.md section 9): the label solver, the
 * reveal matrix and the token map are three things that get tuned repeatedly, and they were
 * interleaved with six thousand lines of unrelated code.
 *
 * Built from walkmap_reference.html. Differences from that reference, all deliberate:
 *   - the payload is fetched live rather than embedded;
 *   - building heights come from `h_m` in the payload, so the reference's lot-key lookup
 *     table is gone (the server change it asked for is done);
 *   - the reference's own transport (play button, scrubber, speed) is replaced by the
 *     visualizer's TimelinePlayer via `player.onSeek`, so the map, the speech lanes and the
 *     audio all run off one clock;
 *   - every DOM lookup is scoped to the panel root, because the reference is a standalone
 *     page and its ids (`map`, `play`, `seek`, `theme`, `status`) collide with the shell's.
 *
 * The browser still never re-derives the walk. `run` and `trace` come from replay.py, the same
 * code that produces the scores, and everything here is presentational.
 *
 * The v1 renderer is kept in app.js as renderNycGeoMapV1 and can be selected with
 * `?walkmap=v1` or localStorage.walkmap="v1".
 */
/* DEMO: the payload is handed in, not fetched. It is the identical {world, run, trace}
   object the live endpoint returns, snapshotted to JSON by make_payloads.py, so nothing
   downstream of here knows the difference. Returns a handle the page uses to tear the
   instance down before building the next one. */
window.renderGeoDemo = function ({ GEO, host, voice, compact }) {
  if (!host) return null;
  const divHost = compact ? null : document.getElementById("geo-div");

  // The panel's own markup. `data-el` rather than `id`, so nothing can collide with the shell.
  host.innerHTML = `
    <div class="wm-root">
     <div class="wm-body">
      <div class="wm-stage">
        <svg data-el="map" class="wm-svg"></svg>
        <!-- Controls float ON the map as translucent tiles rather than sitting in a row above
             it. The row cost a full band of vertical space and left white margins at the sides;
             overlaying returns that space to the map, which is the thing worth looking at. -->
        <div class="wm-bar wm-over">
          <button data-el="zin"    class="wm-tile">+</button>
          <button data-el="zout"   class="wm-tile">&minus;</button>
          <button data-el="all"    class="wm-tile">Whole map</button>
          <span class="wm-sep"></span>
          <button data-el="tIdeal"  class="wm-tile on">Ideal route</button>
          <button data-el="tClear"  class="wm-tile">Route if clear</button>
          <button data-el="tFov"    class="wm-tile">Field of view</button>
          <button data-el="tBelief" class="wm-tile on">Belief</button>
          <button data-el="tLabels" class="wm-tile on">Labels</button>
          <button data-el="tAspect" class="wm-tile">True proportions</button>
          <button data-el="tTheme"  class="wm-tile wm-glyph" title="Switch the map to light">&#9728;</button>
        </div>
        <span data-el="chip" class="wm-chip wm-over-chip"></span>
        <!-- Re-centre lives ON the map beside the scale bar, as a round glyph button, because
             that is where every map application puts it and where the hand expects to find it.
             It was a labelled tile in the top row, which read as a settings toggle rather than
             a map control. -->
        <button data-el="follow" class="wm-locate on" title="Re-centre on the walker">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4.2"></circle>
            <circle cx="12" cy="12" r="7.6" fill="none"></circle>
            <path d="M12 1.4v3.6M12 19v3.6M1.4 12h3.6M19 12h3.6"></path>
          </svg>
        </button>
        <div class="wm-scale"><div data-el="sbTrack" class="wm-sbtrack"></div>
          <span data-el="sbTxt"></span></div>
      </div>
      <!-- DEMO: the voice rail. Hidden until somebody asks for it, because the silent map is
           the default view and a transcript beside it is a different, slower kind of looking.
           When it is open the page switches to the REAL call clock and the audio drives the
           map, so what is on screen is what was happening when that line was spoken. -->
      <aside data-el="rail" class="wm-rail" hidden>
        <div class="wm-rail-head">
          <span data-el="railTitle">Call audio</span>
          <audio data-el="audio" preload="none" controls></audio>
          <span data-el="railNote" class="wm-rail-note"></span>
        </div>
        <div data-el="utts" class="wm-utts"></div>
      </aside>
     </div>
      <!-- The run summary used to float top-right over the map, occluding several blocks.
           It is a running read-out of the replayed state at the current timeline position,
           so it belongs under the map where it cannot hide the thing it describes. -->
      <div data-el="status" class="wm-status"></div>
      <!-- DEMO: "Synced to audio" became "Loop", because there is no audio to sync to.
           The directions rail and the spoken line are gone for the same reason: this page
           is the world, not the conversation. -->
      <!-- DEMO: the speech activity timeline. Only voice mode shows it, and voice mode is a
           different thing from the looping walk: the recording is the clock, nothing loops,
           and this strip is where the duplex behaviour lives. Two lanes, who held the channel,
           where they talked over each other, every tool call, every audio effect the harness
           applied and every contested turn the analyser labelled. -->
      <div data-el="tl" class="wm-tl" hidden>
        <div class="wm-tl-keys"><span class="k-agent">Copilot</span><span class="k-user">Walker</span></div>
        <div data-el="tlStage" class="wm-tl-stage">
          <canvas data-el="tlc" class="wm-tl-canvas"></canvas>
          <div data-el="tlHead" class="wm-tl-head"></div>
        </div>
      </div>
      <div data-el="callbar" class="wm-call" hidden>
        <button data-el="cPlay" class="wm-tile">Pause</button>
        <span data-el="cTime" class="wm-chip">0:00 / 0:00</span>
        <button data-el="cBack" class="wm-tile" title="Back ten seconds">&#8722;10s</button>
        <button data-el="cFwd"  class="wm-tile" title="Forward ten seconds">+10s</button>
        <button data-el="cRestart" class="wm-tile">Restart call</button>
        <span data-el="cStats" class="wm-chip"></span>
        <span class="wm-sep"></span>
        <button data-el="cExit" class="wm-tile on">Leave voice</button>
      </div>
      <div class="wm-steps">
        <button data-el="sPrev" class="wm-tile" title="Previous step">&#8592;</button>
        <button data-el="sPlay" class="wm-tile">Pause</button>
        <button data-el="sNext" class="wm-tile" title="Next step">&#8594;</button>
        <input data-el="sRange" type="range" min="0" value="0" class="wm-range">
        <span data-el="sLabel" class="wm-chip"></span>
        <button data-el="sVoice" class="wm-tile"
                title="Play the real call and drive the map from it">Voice</button>
        <button data-el="sLive" class="wm-tile on"
                title="Restart the walk when it reaches the destination">Loop</button>
      </div>
      <div class="wm-legend" data-el="legend"></div>
    </div>`;

  const root = host.querySelector(".wm-root");
  // The map carries its own light/dark switch, separate from the shell's. A dark shell with a
  // light map is the normal combination for reading a map, and it is what screenshots want.
  const mapTheme = (v) => {
    root.classList.toggle("wm-light", v === "light");
    /* DEMO: the page follows the map. In the visualizer the shell carries its own theme
       switch, so a light map on a dark shell is a deliberate combination someone chose. Here
       there is one control, and leaving the page dark behind a light map put the read-out and
       the legend in dark ink on a dark ground: they use the map's own --label token, which
       flips with it. One switch, one theme. */
    document.body.classList.toggle("wm-page-light", v === "light");
    // DEMO: namespaced. The shared key meant flipping this page to light silently
    // relit the live visualizer's map in the same browser.
    localStorage.setItem("duplexworld-theme", v);
    const b = root.querySelector('[data-el="tTheme"]');
    if (b) {
      // Same glyphs as the shell's own theme button, and the same convention: the icon shows
      // the mode you would switch TO, not the one you are in.
      b.textContent = v === "light" ? "\u{1F319}" : "\u2600";
      b.title = v === "light" ? "Switch the map to dark" : "Switch the map to light";
      b.classList.toggle("on", v === "light");
    }
    if (window.__wmAudit && window.__wmAudit.repaint) window.__wmAudit.repaint();
  };
  // Shims for the handful of controls the reference page owned that the visualizer's own
  // transport now provides. They absorb the reference's writes without creating UI.
  const SINK = () => {
    const n = document.createElement("span");
    Object.defineProperty(n, "value", { get: () => 0, set: () => {} });
    return n;
  };
  const sinks = { seek: SINK(), play: SINK(), speed: SINK(), tnum: SINK(), tdur: SINK(),
                  theme: SINK() };
  const $el = (id) => root.querySelector(`[data-el="${id}"]`) || sinks[id] || SINK();




/* ===========================================================================
   ROOF PLANS
   Top-view building rendering. Two systems:

   A. LANDMARK PLANS - hand-authored, one function per iconic building, keyed
      by name. Each fills whatever box it is handed, so it works at any zoom
      and under either geometry (square blocks or true proportions).
   B. PROCEDURAL ROOFS - everything else. Deterministic from the lot key, so
      a building looks the same on every reload and across sessions.

   Everything is vector. No raster: these are inspected across a 20x zoom
   range, and a PNG would be soft at the top of it and wasteful at the bottom.

   Convention for every plan fn: (g, x, y, w, h, o) where
     g = <g> to append into,  x,y,w,h = footprint box in MAP UNITS (metres),
     o = { roof, line, glass, green, accent, plant } token names.
   =========================================================================== */

const NSU = "http://www.w3.org/2000/svg";
const el = (t, a) => { const e = document.createElementNS(NSU, t);
  for (const k in a) if (a[k] != null) e.setAttribute(k, a[k]); return e; };
const rr = (x,y,w,h,fill,stroke,sw,rx) =>
  el("rect",{x,y,width:Math.max(0,w),height:Math.max(0,h),rx:rx??0,fill,stroke,"stroke-width":sw});
const ci = (cx,cy,r,fill,stroke,sw) =>
  el("circle",{cx,cy,r:Math.max(0,r),fill,stroke,"stroke-width":sw});
const ln = (x1,y1,x2,y2,stroke,sw,op) =>
  el("line",{x1,y1,x2,y2,stroke,"stroke-width":sw,"stroke-opacity":op,"stroke-linecap":"round"});
const pg = (pts,fill,stroke,sw) =>
  el("polygon",{points:pts.map(p=>p.join(",")).join(" "),fill,stroke,"stroke-width":sw});

/* hash → stable pseudo-random in [0,1) for a given lot key */
function hash01(str, salt=0){
  let h = 2166136261 ^ salt;
  for (let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/* ------------------------------------------------------------------ A. LANDMARKS */
const ROOF_PLANS = {

  /* Beaux-Arts terminal: main concourse block, the barrel-vaulted train shed
     glazing running E-W, the 42nd St headhouse strip, and the Park Avenue
     viaduct arms that wrap the building to the north. */
  "Grand Central Terminal"(g,x,y,w,h,o){
    const m = Math.min(w,h)*0.055;
    g.appendChild(rr(x+m,y+m,w-2*m,h-2*m, o.roof, o.line, m*0.16, m*0.3));
    // concourse: the big volume at the south end
    const ch = (h-2*m)*0.42;
    g.appendChild(rr(x+m*2.2, y+h-m-ch, w-4.4*m, ch, o.glass, o.line, m*0.14, m*0.2));
    // train shed: glazing bays over the platforms, with a spine and platform ties
    const bands = 11, top = y+m*2.4, span = (h-2*m-ch-m*2.2), bh = span/bands;
    for(let i=0;i<bands;i++)
      g.appendChild(rr(x+m*2.4, top+i*bh+bh*0.20, w-4.8*m, bh*0.56, o.glass, null,0, bh*0.10));
    g.appendChild(ln(x+w/2, top, x+w/2, top+span, o.line, m*0.30, .55));
    for(let i=0;i<=bands;i++)
      g.appendChild(ln(x+m*2.4, top+i*bh, x+w-m*2.4, top+i*bh, o.line, m*0.13, .40));
    // 42nd St facade strip
    g.appendChild(rr(x+m*1.4, y+h-m*2.2, w-2.8*m, m*1.1, o.accent, null,0, m*0.3));
    // Park Ave viaduct arms
    g.appendChild(rr(x-m*0.6, y+m*1.2, m*1.5, h*0.5, o.accent, null,0, m*0.3));
    g.appendChild(rr(x+w-m*0.9, y+m*1.2, m*1.5, h*0.5, o.accent, null,0, m*0.3));
  },

  /* Secretariat slab + the domed General Assembly + riverside garden. */
  "United Nations Headquarters"(g,x,y,w,h,o){
    const m = Math.min(w,h)*0.05;
    g.appendChild(rr(x+m,y+m,w-2*m,h-2*m, o.roof, o.line, m*0.14, m*0.25));
    // garden strip along the river (east edge)
    g.appendChild(rr(x+w-m*3.6, y+m*1.6, m*2.4, h-3.2*m, o.green, null,0, m*0.3));
    // Secretariat: tall narrow slab, long axis N-S
    const sw_ = (w-2*m)*0.34, sx = x+m+ (w-2*m)*0.16, sy = y+h*0.30, sh = h*0.40;
    g.appendChild(rr(sx, sy, sw_, sh, o.glass, o.line, m*0.14, m*0.2));
    for(let i=1;i<5;i++) g.appendChild(ln(sx+sw_*i/5, sy, sx+sw_*i/5, sy+sh, o.line, m*0.1, .5));
    // General Assembly: domed, to the north
    const gx = x+m+(w-2*m)*0.12, gy = y+h*0.13, gw=(w-2*m)*0.44, gh=h*0.13;
    g.appendChild(rr(gx,gy,gw,gh,o.accent,o.line,m*0.12,gh*0.45));
    g.appendChild(ci(gx+gw*0.5, gy+gh*0.5, gh*0.34, o.roof, o.line, m*0.12));
    // plaza
    g.appendChild(rr(x+m*1.6, y+h-h*0.20, (w-2*m)*0.5, h*0.10, o.plant, null,0, m*0.25));
  },

  /* Concentric setbacks and the radiating sunburst crown, read from above. */
  "Chrysler Building"(g,x,y,w,h,o){
    const cx=x+w/2, cy=y+h/2, R=Math.min(w,h)/2;
    g.appendChild(rr(x,y,w,h,o.roof,o.line,R*0.05,R*0.06));
    for(let i=1;i<=3;i++){
      const k=1-i*0.19;
      g.appendChild(rr(cx-w*k/2, cy-h*k/2, w*k, h*k, o.roof, o.line, R*0.045, R*0.05));
    }
    // sunburst spokes
    for(let i=0;i<16;i++){
      const a=i*Math.PI/8;
      g.appendChild(ln(cx+Math.cos(a)*R*0.16, cy+Math.sin(a)*R*0.16,
                       cx+Math.cos(a)*R*0.40, cy+Math.sin(a)*R*0.40, o.accent, R*0.035, .85));
    }
    g.appendChild(ci(cx,cy,R*0.15,o.accent,o.line,R*0.04));
    g.appendChild(ci(cx,cy,R*0.055,o.glass,null,0));      // the spire
  },

  /* The elongated octagon everyone recognises from the air. */
  "MetLife Building"(g,x,y,w,h,o){
    const c=Math.min(w,h)*0.26;
    g.appendChild(pg([[x+c,y],[x+w-c,y],[x+w,y+c],[x+w,y+h-c],
                      [x+w-c,y+h],[x+c,y+h],[x,y+h-c],[x,y+c]], o.roof,o.line,c*0.09));
    const k=0.5;
    g.appendChild(rr(x+w*(1-k)/2, y+h*(1-k)/2, w*k, h*k, o.glass, o.line, c*0.07, c*0.12));
    g.appendChild(ci(x+w/2,y+h/2,Math.min(w,h)*0.075,o.accent,null,0));   // helipad
  },

  /* Central tower over a through-block base, with the two Park Ave portals
     notched into the south edge and a pyramidal cupola. */
  "Helmsley Building"(g,x,y,w,h,o){
    const m=Math.min(w,h)*0.06;
    g.appendChild(rr(x,y,w,h,o.roof,o.line,m*0.8,m*0.4));
    g.appendChild(rr(x+w*0.30,y+h*0.22,w*0.40,h*0.56,o.glass,o.line,m*0.7,m*0.3));
    const cx=x+w/2, cy=y+h/2, r=Math.min(w,h)*0.11;
    g.appendChild(pg([[cx,cy-r],[cx+r,cy],[cx,cy+r],[cx-r,cy]], o.accent,o.line,m*0.5));
    // the two vehicular portals
    g.appendChild(rr(x+w*0.20,y+h-m*1.1,w*0.14,m*1.1,o.plant,null,0,m*0.3));
    g.appendChild(rr(x+w*0.66,y+h-m*1.1,w*0.14,m*1.1,o.plant,null,0,m*0.3));
  },

  /* Limestone base with the twin towers at the north end. */
  "Waldorf Astoria"(g,x,y,w,h,o){
    const m=Math.min(w,h)*0.06;
    g.appendChild(rr(x,y,w,h,o.roof,o.line,m*0.8,m*0.35));
    g.appendChild(rr(x+w*0.10,y+h*0.10,w*0.32,h*0.34,o.glass,o.line,m*0.6,m*0.25));
    g.appendChild(rr(x+w*0.58,y+h*0.10,w*0.32,h*0.34,o.glass,o.line,m*0.6,m*0.25));
    g.appendChild(rr(x+w*0.14,y+h*0.56,w*0.72,h*0.30,o.accent,null,0,m*0.3));
  },

  /* The famous L wrapped around a twelve-storey planted atrium. */
  "Ford Foundation Center"(g,x,y,w,h,o){
    const m=Math.min(w,h)*0.07;
    g.appendChild(rr(x,y,w,h,o.roof,o.line,m*0.7,m*0.35));
    g.appendChild(rr(x+w*0.30,y+h*0.16,w*0.56,h*0.68,o.green,o.line,m*0.6,m*0.3));
    for(let i=0;i<5;i++){
      const a=hash01("ff",i);
      g.appendChild(ci(x+w*(0.36+a*0.44), y+h*(0.24+hash01("ff2",i)*0.52),
                       Math.min(w,h)*0.045, o.plant, null, 0));
    }
    g.appendChild(rr(x+w*0.06,y+h*0.16,w*0.18,h*0.68,o.glass,o.line,m*0.5,m*0.25));
  },

  /* Vertically-banded slab; from above, the striations and the setback core. */
  "Daily News Building"(g,x,y,w,h,o){
    const m=Math.min(w,h)*0.06;
    g.appendChild(rr(x,y,w,h,o.roof,o.line,m*0.8,m*0.3));
    for(let i=1;i<7;i++) g.appendChild(ln(x+w*i/7,y+h*0.10,x+w*i/7,y+h*0.90,o.line,m*0.42,.6));
    g.appendChild(rr(x+w*0.34,y+h*0.36,w*0.32,h*0.28,o.glass,o.line,m*0.5,m*0.2));
    g.appendChild(ci(x+w*0.5,y+h*0.5,Math.min(w,h)*0.06,o.accent,null,0));   // the globe
  },

  /* Lawn, gravel terraces, perimeter London planes. */
  "Bryant Park"(g,x,y,w,h,o){
    g.appendChild(rr(x,y,w,h,o.green,o.line,Math.min(w,h)*0.03,Math.min(w,h)*0.06));
    const p=Math.min(w,h)*0.16;
    g.appendChild(rr(x+p,y+p,w-2*p,h-2*p,o.greenLawn||o.green,null,0,Math.min(w,h)*0.05));
    const n=Math.max(3,Math.round(w/Math.max(1,Math.min(w,h))*4));
    for(let i=0;i<n;i++){
      const t=(i+0.5)/n;
      g.appendChild(ci(x+w*t, y+p*0.5, p*0.32, o.plant,null,0));
      g.appendChild(ci(x+w*t, y+h-p*0.5, p*0.32, o.plant,null,0));
    }
  },
  "Tudor City Greens"(g,x,y,w,h,o){ ROOF_PLANS["Bryant Park"](g,x,y,w,h,o); },

  /* Plaza with the tram cable running out over the river. */
  "Roosevelt Island Tram Plaza"(g,x,y,w,h,o){
    const m=Math.min(w,h)*0.08;
    g.appendChild(rr(x,y,w,h,o.plant,o.line,m*0.6,m*0.3));
    g.appendChild(rr(x+w*0.18,y+h*0.30,w*0.30,h*0.40,o.roof,o.line,m*0.5,m*0.2));
    g.appendChild(ln(x+w*0.46,y+h*0.5,x+w*1.05,y+h*0.5,o.accent,m*0.5,.9));
    g.appendChild(ci(x+w*0.33,y+h*0.5,m*0.5,o.glass,null,0));
  },

  /* Small cultural building around a courtyard garden. */
  "Japan Society"(g,x,y,w,h,o){
    const m=Math.min(w,h)*0.09;
    g.appendChild(rr(x,y,w,h,o.roof,o.line,m*0.6,m*0.3));
    g.appendChild(rr(x+w*0.22,y+h*0.24,w*0.56,h*0.52,o.green,o.line,m*0.5,m*0.25));
    g.appendChild(ci(x+w*0.5,y+h*0.5,Math.min(w,h)*0.09,o.glass,null,0));
  },
  "Amster Yard"(g,x,y,w,h,o){ ROOF_PLANS["Japan Society"](g,x,y,w,h,o); },
  "One Dag Hammarskjold Plaza"(g,x,y,w,h,o){
    const m=Math.min(w,h)*0.07;
    g.appendChild(rr(x,y,w,h,o.roof,o.line,m*0.7,m*0.3));
    g.appendChild(rr(x+w*0.12,y+h*0.60,w*0.76,h*0.30,o.plant,null,0,m*0.3));
    g.appendChild(rr(x+w*0.24,y+h*0.10,w*0.52,h*0.42,o.glass,o.line,m*0.5,m*0.2));
  },
};

/* --------------------------------------------------------------- B. PROCEDURAL */
/* Rooftop vocabulary of real Midtown seen from above: setback terraces on the
   tall ones, mechanical plant, stair bulkheads, light-wells on deep lots, and
   the wooden water tanks that are the giveaway that this is New York. */
function proceduralRoof(g, x, y, w, h, o, key, height_m){
  const S = Math.min(w,h);
  const r1 = hash01(key,1), r2 = hash01(key,2), r3 = hash01(key,3), r4 = hash01(key,4);

  // setback terrace on tall buildings
  if (height_m > 95){
    const k = 0.80 - r1*0.12;
    g.appendChild(rr(x+w*(1-k)/2, y+h*(1-k)/2, w*k, h*k, o.roof, o.line, S*0.018, S*0.03));
  }
  // light-well on deep, large lots
  if (w*h > 2600 && r2 > 0.55){
    const ww=w*0.20, hh=h*0.26;
    g.appendChild(rr(x+w*0.5-ww/2, y+h*0.5-hh/2, ww, hh, o.well, o.line, S*0.015, S*0.02));
  }
  // mechanical plant: one or two blocks toward the rear
  const nPlant = r3 > 0.45 ? 2 : 1;
  for (let i=0;i<nPlant;i++){
    const a=hash01(key,10+i), b=hash01(key,20+i);
    const pw=S*(0.15+a*0.13), ph=S*(0.11+b*0.10);
    g.appendChild(rr(x+w*(0.16+a*0.58), y+h*(0.16+b*0.56), pw, ph, o.plant, null, 0, S*0.02));
  }
  // stair bulkhead, hugging a corner
  const cx = r4<0.5 ? x+w*0.08 : x+w*0.78, cy = r1<0.5 ? y+h*0.08 : y+h*0.76;
  g.appendChild(rr(cx, cy, S*0.14, S*0.13, o.plant, null, 0, S*0.02));
  // water tank
  if (r2 < 0.42){
    const tx = x+w*(0.24+r3*0.5), ty = y+h*(0.24+r4*0.5), tr = S*0.075;
    g.appendChild(ci(tx,ty,tr*1.25,o.tankShadow,null,0));
    g.appendChild(ci(tx,ty,tr,o.tank,o.line,S*0.013));
    g.appendChild(ci(tx,ty,tr*0.34,o.line,null,0));
  }
}

/* ---------------------------------------------------------------- C. PIN GLYPHS */
/* Deliberately geometric. At 11-13 css px a detailed icon is mush; a
   recognisable silhouette built from 2-4 primitives is not. */
function pinGlyph(cat, cx, cy, r, col){
  const g = el("g",{}); const S=r;
  const add=(e)=>{g.appendChild(e);return g;};
  const bar=(dx,dy,w,h,rx)=>rr(cx+dx*S,cy+dy*S,w*S,h*S,col,null,0,(rx??0)*S);
  switch(cat){
    case "restaurant": case "deli": case "food":
      add(bar(-.52,-.62,.16,1.24,.08)); add(bar(-.10,-.62,.16,.55,.08));
      add(bar(.16,-.62,.16,.55,.08));   add(bar(.02,-.20,.16,.82,.08)); break;
    case "cafe":
      add(bar(-.55,-.35,.90,.75,.14)); add(ci(cx+S*.52,cy-S*.02,S*.26,col,null,0)); break;
    case "bakery":
      add(el("ellipse",{cx,cy,rx:S*.72,ry:S*.46,fill:col}));
      add(ln(cx-S*.3,cy-S*.1,cx-S*.1,cy+S*.16,"#0006",S*.14,1)); break;
    case "hotel": case "lodging":
      add(bar(-.70,-.10,1.40,.62,.10)); add(ci(cx-S*.34,cy-S*.28,S*.28,col,null,0));
      add(bar(-.70,-.62,.18,.55,.06)); break;
    case "clinic":
      add(bar(-.18,-.68,.36,1.36,.08)); add(bar(-.68,-.18,1.36,.36,.08)); break;
    case "pharmacy":
      add(el("rect",{x:cx-S*.70,y:cy-S*.34,width:S*1.40,height:S*.68,rx:S*.34,fill:col,
        transform:`rotate(-38 ${cx} ${cy})`}));
      add(ln(cx-S*.15,cy-S*.30,cx+S*.20,cy+S*.24,"var(--glyph-shade)",S*.16,1)); break;
    case "library": case "bookshop":
      add(bar(-.62,-.60,.42,1.20,.05)); add(bar(-.14,-.60,.34,1.20,.05));
      add(bar(.26,-.60,.38,1.20,.05)); break;
    case "bank":
      add(bar(-.72,-.62,1.44,.22,.05)); add(bar(-.52,-.30,.20,.80,.04));
      add(bar(-.10,-.30,.20,.80,.04)); add(bar(.32,-.30,.20,.80,.04)); break;
    case "park":
      add(ci(cx,cy-S*.20,S*.56,col,null,0)); add(bar(-.10,.24,.20,.52,.05)); break;
    case "transit": case "entrance":
      add(bar(-.56,-.66,1.12,1.00,.20)); add(bar(-.36,-.44,.72,.42,.06));
      add(ci(cx-S*.30,cy+S*.46,S*.16,col,null,0)); add(ci(cx+S*.30,cy+S*.46,S*.16,col,null,0)); break;
    case "landmark":
      add(pg([[cx,cy-S*.78],[cx+S*.24,cy-S*.18],[cx+S*.76,cy-S*.14],
              [cx+S*.36,cy+S*.24],[cx+S*.48,cy+S*.76],[cx,cy+S*.46],
              [cx-S*.48,cy+S*.76],[cx-S*.36,cy+S*.24],[cx-S*.76,cy-S*.14],
              [cx-S*.24,cy-S*.18]], col,null,0)); break;
    case "cultural":
      add(bar(-.74,.34,1.48,.28,.06)); add(bar(-.74,-.72,1.48,.22,.06));
      add(bar(-.50,-.44,.22,.76,.04)); add(bar(-.11,-.44,.22,.76,.04));
      add(bar(.28,-.44,.22,.76,.04)); break;
    case "market": case "shop":
      add(bar(-.62,-.24,1.24,.90,.10)); add(el("path",{
        d:`M ${cx-S*.34} ${cy-S*.24} a ${S*.34} ${S*.40} 0 0 1 ${S*.68} 0`,
        fill:"none",stroke:col,"stroke-width":S*.20})); break;
    case "gym":
      add(bar(-.72,-.22,1.44,.44,.10)); add(bar(-.86,-.44,.26,.88,.08));
      add(bar(.60,-.44,.26,.88,.08)); break;
    default:
      add(ci(cx,cy,S*.60,col,null,0));
  }
  return g;
}


const W = GEO.world, R = GEO.run, TRACE = GEO.trace;
const NAV = W.avenues.length, NST = W.streets.length;

/* ===========================================================================
   2. GEOMETRY
   The drawing is deliberately not to scale. Keep the two block dimensions as
   separate constants so the choice is one line, not a refactor. Every metric
   comes from replay.py on the graph, so changing these cannot affect a score.
   real Midtown: 274 m avenue-to-avenue x 81 m street-to-street (3.4 : 1)
   =========================================================================== */
const GEOM = {
  square: {BW:220, BH:220, AV:34, ST:26},   // current behaviour
  true_:  {BW:274, BH:110, AV:30, ST:20},   // 2.5:1 - Manhattan texture, still readable
};
let G = GEOM.square;
const AVP=()=>G.BW+G.AV, STP=()=>G.BH+G.ST;
const nodeX=i=>i*AVP()+G.AV/2, nodeY=k=>k*STP()+G.ST/2;
const MW=()=>(NAV-1)*AVP()+G.AV, MH=()=>(NST-1)*STP()+G.ST;
const blockBox=(i,k)=>({x:nodeX(i)+G.AV/2,y:nodeY(k)+G.ST/2,w:G.BW,h:G.BH});

/* --- adjacency, derived from segments. Nodes are implicit; superblocks
   delete segments, so a full i,k loop would invent streets that do not
   exist (E 43rd and E 44th genuinely stop at Grand Central). ------------- */
const ADJ={}, SEGSET=new Set();
for(const s_ of W.segments){
  (ADJ[s_.from] ||= []).push(s_.to); (ADJ[s_.to] ||= []).push(s_.from);
  SEGSET.add(s_.from+"|"+s_.to); SEGSET.add(s_.to+"|"+s_.from);
}
const LIVE_NODES = new Set(Object.keys(ADJ));
const segAxis=s_=>W.nodes[s_.from][0]===W.nodes[s_.to][0]?"av":"st";
const NOX=new Set((W.no_crossing||[]).map(([n,side])=>n+"|"+side));

/* --- contiguous lot packing -------------------------------------------------
   The payload's fx0..fx1 leave ~13% gaps between lots because they come from
   the legacy 274 m grid. Real blocks are continuous built frontage; the gaps
   read as missing teeth and steal label room. Re-normalise each row so the
   three lots fill the frontage in proportion to w_m, separated by a hairline. */
const LOTS={};
for(const b of W.buildings){
  const key=`${b.i}_${b.k}_${b.row}`; (LOTS[key] ||= []).push(b);
}
for(const key in LOTS){
  const row=LOTS[key].sort((a,b)=>a.fx0-b.fx0);
  const total=row.reduce((s_,b)=>s_+b.w_m,0);
  const M=0.028, GAP=0.006;                       // block margin, lot gap
  const avail=1-2*M-GAP*(row.length-1);
  let x=M;
  row.forEach((b,idx)=>{ const w=avail*(b.w_m/total); b._x0=x; b._x1=x+w; x+=w+GAP;
    b.lotIdx=idx;
    // h_m now ships in the /geo payload for all 240 buildings, so the lot-key lookup
    // table the reference shipped as a stopgap is gone.
    b.height_m = b.h_m ?? 70; });
  const depth=0.5-M-GAP/2;
  for(const b of row){
    b._y0 = b.row===0 ? M : 0.5+GAP/2;
    b._y1 = b._y0 + depth*(b.d_m/Math.max(...row.map(r=>r.d_m)));
    if(b.row===1){ const h=b._y1-b._y0; b._y1=1-M; b._y0=b._y1-h; }
  }
}
const bKey=b=>`${b.i}_${b.k}_${b.row}_${b.lotIdx??b.fx0.toFixed(3)}`;

/* ===========================================================================
   3. VIEW - zoom tiers gate on the PIXEL SIZE of a real thing, never on the
   metre span. A rule like "labels when VIEW<600" breaks on resize.
   =========================================================================== */
const svg=$el("map"), NS="http://www.w3.org/2000/svg";
const s=(t,a)=>{const e=document.createElementNS(NS,t);for(const k in a)if(a[k]!=null)e.setAttribute(k,a[k]);return e;};
let VIEW=760, CX=0, CY=0;
let follow=true, showFov=true, showBelief=true, showLabels=true, now=0, playing=false;
/* DEMO: the glide overlay. Null means "the walker is standing on a corner", and everything
   behaves exactly as the shipped renderer does. Non-null means we are mid-step, and it
   carries the interpolated position, the tweened compass bearing, and which block is being
   walked so the trail can be drawn part-way. The DISCRETE state is never interpolated: the
   routes, the belief ring, the closures and the block count all still come from stateAt()
   at the corner the walker last stood on. Only the marker and its trail move smoothly. */
let GLIDE=null;
/* DEMO: cache for the field-of-view building highlight, see the fix in drawStateNow. */
const LIT_NODES={g:null,els:[]}; let LIT_PREV=null;
/* DEMO: true only during the loop's cut back to the start, so the follow-camera does not
   chase the walker across the map on a rewind. */
let REWINDING=false;
/* DEMO: true when this instance is a gallery tile. Declared here with the rest of the
   renderer's state rather than at the entry point, because everything from the entry point
   down to here is above these declarations and would read it inside its dead zone. */
let COMPACT=!!compact;
/* DEMO: set the moment the viewer pans, zooms or turns following on. Once true the page
   stops re-framing the journey by itself, so a resize cannot undo a deliberate zoom. */
let USERCAM=false;
/* DEMO: the action the walker is performing right now. While mid-step that is the stop being
   walked TO, not the one just left: st.say holds the text of the last event at or before
   `now`, and `now` is deliberately pinned to the corner behind the walker, so reading it
   directly captioned every glide with the step that had already finished. */
let ACTION="";
/* The two ideal routes are separately toggleable. Both are diagnostic and on a blocked map they
   overlap, so the defaults matter: the route the agent was ACTUALLY asked for is on, and the
   clear-map route - which only tells you what the copilot reached for first - is off until
   asked for. On an unblocked task they are the same walk, and the clear one is suppressed
   entirely rather than drawn twice. */
let showIdeal=true, showClear=false;
const px=()=>svg.clientWidth||900, mpp=()=>VIEW/px(), m2p=m=>m/mpp();
const vh=()=>VIEW*(svg.clientHeight/(svg.clientWidth||1));

/* ---------------------------------------------------------------------------
   THE REVEAL MATRIX. One table, in on-screen block-pixels, for every element
   the map can draw. This is the whole zoom policy: read it, argue with it,
   change a number. Nothing else in the file decides what is visible.
   --------------------------------------------------------------------------- */
/* Calibrated to the ACTUAL usable range of this world. Midtown East is only
   ~1780 m across, so at maximum zoom-out a 220 m block is still ~95 px: the
   thresholds have to live between ~95 and ~1300, not between 0 and 400.
   Re-derive these if you change the world size or the block constants. */
const VIS = {
  //                    min block px   first visible in
  blockMass:         0,   //           overview
  superblockMass:    0,   //           overview
  roads:             0,   //           overview
  superblockLabel:   0,   //           overview
  routeAndWalker:    0,   //           overview   (state is never hidden)
  buildingMass:     90,   //           overview   (texture, uniform fill)
  avenueLabel:      90,   //           overview
  roadCasing:       90,   //           overview
  lotLines:        150,   //           block
  heightShading:   150,   //           block
  streetLabel:     150,   //           block
  pinBig:          150,   //           block
  labelBig:        190,   //           block
  superblockRoof:  190,   //           block
  pinSmall:        260,   //           lot
  labelReal:       260,   //           lot
  roofDetail:      300,   //           lot
  crosswalks:      300,   //           lot
  noCrossing:      300,   //           lot
  pinGlyph:        300,   //           lot
  labelPoi:        380,   //           detail
  labelSmallPlace: 380,   //           detail
  entrances:       600,   //           close
  labelGeneric:    700,   //           close
};
const blkPx = () => m2p(G.BW);
const vis   = k => blkPx() >= VIS[k];
function TIER(){ return {blk:blkPx(), lot:m2p(G.BW*0.3),
  fovRadius:Math.min(150, G.BW*0.62, VIEW*0.28)}; }
const tierName=()=>{const b=blkPx();
  return b<150?"overview":b<260?"block":b<380?"lot":b<700?"detail":"close";};

let anim=null;
function writeView(){
  svg.setAttribute("viewBox",`${CX-VIEW/2} ${CY-vh()/2} ${VIEW} ${vh()}`);
  $el("chip").textContent=
    `${Math.round(VIEW)} m across · ${mpp().toFixed(2)} m/px · ${tierName()}`;
  scalebar();
}
let TGT={v:VIEW,x:CX,y:CY};
function easeTo(v,cx,cy,ms=340){
  const v0=VIEW,x0=CX,y0=CY,t0=performance.now();
  TGT={v,x:cx,y:cy};
  if(anim)cancelAnimationFrame(anim);
  const f=t=>1-Math.pow(1-t,3);
  /* DEMO: this used to call redrawZoom() every frame, which re-ran the whole collision
     label solver and rebuilt every building on each frame of every pan. That is what made
     labels visibly jitter during a camera move, and with the walker now gliding the camera
     is in motion most of the time. The heavy pair only needs to run when the zoom tier
     actually changes, plus once at the end. The state layer still repaints every frame. */
  let tier0=tierName();
  const st=()=>{const p=Math.min(1,(performance.now()-t0)/ms),e=f(p);
    VIEW=v0+(v-v0)*e;CX=x0+(cx-x0)*e;CY=y0+(cy-y0)*e;
    writeView();
    const tier1=tierName();
    if(p>=1||tier1!==tier0){tier0=tier1;drawBuildings();drawLabels();}
    drawStateNow();
    anim=p<1?requestAnimationFrame(st):null;};
  anim=requestAnimationFrame(st);
}

/* ===========================================================================
   4. DEFS
   =========================================================================== */
function defs(){
  const d=s("defs");
  d.innerHTML=`
  <radialGradient id="fade" cx="50%" cy="50%" r="60%">
    <stop offset="52%" stop-color="#fff" stop-opacity="1"/>
    <stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <mask id="beyondMask"><rect id="fadeRect" fill="url(#fade)"/></mask>
  <linearGradient id="wg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="var(--water)"/><stop offset="100%" stop-color="var(--water-2)"/></linearGradient>
  <pattern id="wave" width="44" height="24" patternUnits="userSpaceOnUse">
    <path d="M0 12 q11 -6.5 22 0 t22 0" fill="none" stroke="var(--water-line)" stroke-width="1" stroke-opacity=".5"/></pattern>
  <pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="9" height="9" fill="var(--closed)" fill-opacity=".12"/>
    <line x1="0" y1="0" x2="0" y2="9" stroke="var(--closed)" stroke-width="3" stroke-opacity=".5"/></pattern>
  <filter id="softBlur" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="2.4"/></filter>
  <filter id="glow" x="-70%" y="-70%" width="240%" height="240%">
    <feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  return d;
}

/* ===========================================================================
   5. BASE
   =========================================================================== */
let gBase,gRoadLbl,gLabels,gState,gBldg,city;
function drawBase(){
  gBase.textContent="";
  city=s("g"); gBase.appendChild(city);
  city.appendChild(s("rect",{x:-9000,y:-9000,width:18000,height:18000,fill:"var(--ground)"}));

  /* 5a. "the city continues" - one faded ring of blocks outside the model.
     Better than a hard edge, and better than the current 0.34-opacity copy,
     because the radial mask makes it dissolve instead of stopping. */
  /* the radial fade must be centred on the MODELLED AREA, not on the origin,
     or the ring dissolves on one side and stays hard on the other. */
  const fr=svg.querySelector("#fadeRect");
  fr.setAttribute("x",-MW()); fr.setAttribute("y",-MH());
  fr.setAttribute("width",MW()*3); fr.setAttribute("height",MH()*3);
  const beyond=s("g",{mask:"url(#beyondMask)",opacity:".9"});
  for(let i=-4;i<NAV+3;i++)for(let k=-4;k<NST+3;k++){
    if(i>=0&&i<NAV-1&&k>=0&&k<NST-1) continue;
    const b=blockBox(i,k);
    beyond.appendChild(s("rect",{x:b.x,y:b.y,width:b.w,height:b.h,rx:3,fill:"var(--beyond)"}));
  }
  city.appendChild(beyond);

  /* 5b. water - shoreline, gradient, hatch. Never a flat rectangle. */
  const wx=nodeX(NAV-1)+G.AV/2+G.BW*0.12, H=MH();
  const shore=`M ${wx} ${-H} C ${wx+G.BW*.12} ${H*.18}, ${wx-G.BW*.07} ${H*.36}, ${wx+G.BW*.08} ${H*.54}
     C ${wx+G.BW*.2} ${H*.7}, ${wx-G.BW*.02} ${H*.86}, ${wx+G.BW*.1} ${H*2} L ${wx+G.BW*9} ${H*2} L ${wx+G.BW*9} ${-H} Z`;
  city.appendChild(s("path",{d:shore,fill:"url(#wg)"}));
  city.appendChild(s("path",{d:shore,fill:"url(#wave)",opacity:".45"}));
  city.appendChild(s("path",{d:shore,fill:"none",stroke:"var(--water-line)","stroke-width":1.5,"stroke-opacity":".65"}));

  /* 5c. block masses (skip anything a superblock swallows) */
  const covered=new Set();
  for(const sb of W.superblocks)
    for(let i=sb.av[0];i<sb.av[1];i++)for(let k=sb.st[0];k<sb.st[1];k++)covered.add(i+"_"+k);
  for(let i=0;i<NAV-1;i++)for(let k=0;k<NST-1;k++){
    if(covered.has(i+"_"+k))continue;
    const b=blockBox(i,k);
    city.appendChild(s("rect",{x:b.x,y:b.y,width:b.w,height:b.h,rx:3,fill:"var(--block)"}));
  }
  /* 5d. superblocks - one mass, no internal lots, no streets through them */
  for(const sb of W.superblocks){
    const x0=nodeX(sb.av[0])+G.AV/2, y0=nodeY(sb.st[0])+G.ST/2;
    const x1=nodeX(sb.av[1])-G.AV/2, y1=nodeY(sb.st[1])-G.ST/2;
    sb._box={x0,y0,x1,y1};
    city.appendChild(s("rect",{x:x0,y:y0,width:x1-x0,height:y1-y0,rx:4,
      fill:"var(--struct)",stroke:"var(--struct-line)","stroke-width":1.4}));
  }
  drawBuildings(); drawRoads();
}

/* token bundle handed to every roof plan */
const RT={roof:"var(--roof)",line:"var(--roof-line)",glass:"var(--roof-glass)",
  green:"var(--park)",greenLawn:"var(--park-2)",accent:"var(--roof-accent)",
  plant:"var(--roof-plant)",well:"var(--roof-well)",tank:"var(--roof-tank)",
  tankShadow:"var(--roof-tank-sh)"};
const HMAX=132;   // tallest building in the world file

function drawBuildings(){
  if(gBldg)gBldg.remove();
  gBldg=s("g");
  if(!vis("buildingMass")){ city.appendChild(gBldg); return; }

  /* One blurred group for ALL shadows rather than a filter per building:
     240 filter instances is the difference between 60fps and 12. */
  const shadows=vis("heightShading")?s("g",{filter:"url(#softBlur)",opacity:".5"}):null;
  const bodies=s("g"), roofs=s("g");

  const drawOne=(x,y,w,h,hm,fill,key,name,isSB)=>{
    const t=Math.min(1,Math.max(0,hm/HMAX));
    if(shadows){
      /* light from the NW, so shadows fall SE, length proportional to height.
         This single cue does more for "top view of a city" than any texture. */
      const k=hm*0.055;
      shadows.appendChild(s("rect",{x:x+k,y:y+k,width:w,height:h,rx:2,fill:"var(--bldg-shadow)"}));
    }
    const r=s("rect",{x,y,width:w,height:h,rx:1.8,fill,
      stroke:vis("lotLines")?"var(--bldg-line)":"none","stroke-width":vis("lotLines")?1.1:0});
    r.dataset.base=fill; if(key)r.dataset.key=key;
    bodies.appendChild(r);
    if(!vis("heightShading"))return;
    /* taller roofs sit closer to the light: a lightness ramp, not a hue */
    bodies.appendChild(s("rect",{x,y,width:w,height:h,rx:1.8,fill:"var(--bldg-hi)",
      "fill-opacity":(0.03+0.13*t).toFixed(3),"pointer-events":"none"}));

    if(!(isSB?vis("superblockRoof"):vis("roofDetail")))return;
    const g=s("g",{"pointer-events":"none"});
    const inset=Math.min(w,h)*0.055;
    const plan=ROOF_PLANS[name];
    if(plan) plan(g,x+inset,y+inset,w-2*inset,h-2*inset,RT);
    else proceduralRoof(g,x+inset,y+inset,w-2*inset,h-2*inset,RT,key||name||"x",hm);
    g.setAttribute("opacity",isSB?".95":".85");
    roofs.appendChild(g);
  };

  for(const b of W.buildings){
    const bb=blockBox(b.i,b.k);
    const x=bb.x+b._x0*bb.w, y=bb.y+b._y0*bb.h;
    const w=(b._x1-b._x0)*bb.w, h=(b._y1-b._y0)*bb.h;
    /* The lightness tiers only switch on at the zoom where labels can explain
       them. Unexplained contrast at overview reads as random noise. */
    const fill=!vis("labelReal")?"var(--bldg)"
             :b.real?"var(--bldg-3)":(b.poi?"var(--bldg-2)":"var(--bldg)");
    drawOne(x,y,w,h,b.height_m??70,fill,bKey(b),b.name,false);
  }
  for(const sb of W.superblocks){
    const {x0,y0,x1,y1}=sb._box;
    drawOne(x0,y0,x1-x0,y1-y0,sb.name.includes("United")?155:32,
            "var(--struct)",null,sb.name,true);
  }
  if(shadows)gBldg.appendChild(shadows);
  gBldg.appendChild(bodies); gBldg.appendChild(roofs);
  city.appendChild(gBldg);
}

function drawRoads(){
  const t=TIER(), casing=s("g"), fill=s("g"), marks=s("g");
  const wAv=G.AV*0.74, wSt=G.ST*0.72;
  /* two passes: ALL casings, then ALL fills - per-segment casing/fill leaves a
     grey seam at every junction. */
  for(const sg of W.segments){
    const [i0,k0]=W.nodes[sg.from],[i1,k1]=W.nodes[sg.to];
    const a={x1:nodeX(i0),y1:nodeY(k0),x2:nodeX(i1),y2:nodeY(k1),"stroke-linecap":"butt"};
    const av=segAxis(sg)==="av", w=av?wAv:wSt;
    casing.appendChild(s("line",{...a,stroke:"var(--road-casing)","stroke-width":w+3}));
    fill.appendChild(s("line",{...a,stroke:av?"var(--road-major)":"var(--road)","stroke-width":w}));
  }
  /* crosswalks only on arms that really exist, skipping no_crossing sides */
  if(vis("crosswalks")){
    const SIDE={N:[0,-1],S:[0,1],E:[1,0],W:[-1,0]};
    for(const n of LIVE_NODES){
      const [i,k]=W.nodes[n], x=nodeX(i), y=nodeY(k);
      for(const [side,[dx,dy]] of Object.entries(SIDE)){
        const nb=`n_${i+dx}_${k+dy}`;
        if(!SEGSET.has(n+"|"+nb)) continue;
        if(NOX.has(n+"|"+side)){                      // barrier instead of stripes
          const off=(dx?G.AV:G.ST)/2+2;
          marks.appendChild(s("line",{x1:x+dx*off-(dx?0:wSt/2.6),y1:y+dy*off-(dy?0:wAv/2.6),
            x2:x+dx*off+(dx?0:wSt/2.6),y2:y+dy*off+(dy?0:wAv/2.6),
            stroke:"var(--closed)","stroke-width":2.2,"stroke-opacity":".8","stroke-linecap":"round"}));
          continue;
        }
        const off=(dx?G.AV:G.ST)/2+3.2, span=(dx?wSt:wAv)*0.42;
        for(let j=-1;j<=1;j++){
          const ox=dx?0:j*span/1.6, oy=dx?j*span/1.6:0;
          marks.appendChild(s("line",{
            x1:x+dx*off+ox-dx*2.4, y1:y+dy*off+oy-dy*2.4,
            x2:x+dx*off+ox+dx*2.4, y2:y+dy*off+oy+dy*2.4,
            stroke:"var(--label-dim)","stroke-width":1.3,"stroke-opacity":".3","stroke-linecap":"round"}));
        }
      }
    }
  }
  city.appendChild(casing); city.appendChild(fill); city.appendChild(marks);
}

/* ===========================================================================
   6. LABELS - greedy collision solver over screen-space boxes.
   Zoom-gating alone cannot stop crowding; this can.
   =========================================================================== */
const mc=document.createElement("canvas").getContext("2d"), mcache=new Map();
function measure(txt,font){const k=font+"|"+txt;if(mcache.has(k))return mcache.get(k);
  mc.font=font;const w=mc.measureText(txt).width;mcache.set(k,w);return w;}
const RING=[[1,0],[-1,0],[0,-1],[0,1],[1,-1],[-1,-1],[1,1],[-1,1]];
const toScreen=(x,y)=>[(x-(CX-VIEW/2))/mpp(),(y-(CY-vh()/2))/mpp()];
const box=(x,y,w,h)=>{const[a,b]=toScreen(x,y);return{x1:a-w/2-3,x2:a+w/2+3,y1:b-h/2-2,y2:b+h/2+2};};
const inView=(x,y,p=0)=>x>CX-VIEW/2-p&&x<CX+VIEW/2+p&&y>CY-vh()/2-p&&y<CY+vh()/2+p;

function drawLabels(){
  gLabels.textContent=""; gRoadLbl.textContent="";
  if(!showLabels) return;
  const t=TIER(), placed=[];
  const hit=b=>placed.some(p=>!(b.x2<p.x1||b.x1>p.x2||b.y2<p.y1||b.y1>p.y2));

  /* The state layer owns its space: reserve the walker and belief callouts
     BEFORE any basemap label competes for it. Otherwise a POI name lands
     under "walker: facing south" and both become unreadable. */
  {
    const st=stateAt(now);
    if(LIVE_NODES.has(st.node)){
      const [i,k]=W.nodes[st.node], x=nodeX(i), y=nodeY(k);
      placed.push(box(x,y,m2p(1)*0,0));                    // the marker itself
      placed.push(box(x,y+mpp()*19,150,15));               // "walker: facing X"
      placed.push(box(x,y-mpp()*21,230,15));               // "copilot believes: ..."
      placed.push(box(x,y,mpp()*0+34,34));
    }
  }

  /* 6a. superblocks first - they are the anchors of the scene */
  for(const sb of W.superblocks){
    const {x0,y0,x1,y1}=sb._box, cx=(x0+x1)/2, cy=(y0+y1)/2;
    if(!inView(cx,cy,300))continue;
    const vert=(y1-y0)>(x1-x0)*1.5;
    const fs=Math.max(9.5,Math.min(15,m2p(Math.min(x1-x0,y1-y0))*0.09));
    const font=`600 ${fs}px system-ui`, txt=sb.name.toUpperCase();
    const w=measure(txt,font)*1.18;
    if(w>m2p(vert?(y1-y0):(x1-x0))*0.92) continue;
    const b=box(cx,cy,vert?fs*1.4:w,vert?w:fs*1.4);
    if(hit(b))continue; placed.push(b);
    const e=s("text",{x:cx,y:cy,"text-anchor":"middle","dominant-baseline":"central",
      fill:"var(--struct-text)","font-size":mpp()*fs,"letter-spacing":mpp()*fs*0.15,"font-weight":600,
      transform:vert?`rotate(-90 ${cx} ${cy})`:null});
    e.textContent=txt; gLabels.appendChild(e);
  }

  /* 6b. street names INSIDE the ribbon, once per real segment, collision-tested.
     Iterating the grid instead of the segment list is how you end up drawing
     "E 43RD ST" across Grand Central. */
  if(vis("avenueLabel")){
    const fs=Math.max(8.2,Math.min(11.5,m2p(G.ST)*0.4));
    const font=`600 ${fs}px system-ui`;
    /* Repeat spacing, not one-per-segment. Labelling every segment is what
       makes the overview read as static; real maps repeat a road name roughly
       every 400-600 px and drop the rest. Avenues win ties over streets. */
    const REPEAT=420;
    const lines=new Map();                     // "av:3" | "st:6" -> candidates
    for(const sg of W.segments){
      const [i0,k0]=W.nodes[sg.from],[i1,k1]=W.nodes[sg.to];
      const av=segAxis(sg)==="av";
      const cx=(nodeX(i0)+nodeX(i1))/2, cy=(nodeY(k0)+nodeY(k1))/2;
      if(!inView(cx,cy,60))continue;
      const key=(av?"av:"+i0:"st:"+k0);
      (lines.get(key)||lines.set(key,[]).get(key)).push({cx,cy,av,i:i0,k:k0});
    }
    const ordered=[...lines.entries()].sort((a,b)=>
      (b[0].startsWith("av")?1:0)-(a[0].startsWith("av")?1:0));
    for(const [key,cands] of ordered){
      const av=key.startsWith("av");
      if(!av && !vis("streetLabel")) continue;
      cands.sort((p,q)=>av?p.cy-q.cy:p.cx-q.cx);
      const nm=(av?W.avenues[cands[0].i]:W.streets[cands[0].k]).toUpperCase()
                .replace(" STREET"," ST").replace(" AVENUE"," AVE");
      const w=measure(nm,font)*1.16;
      if(w>m2p(av?G.BH:G.BW)*0.9)continue;
      let lastPx=-1e9;
      for(const c of cands){
        const [sx,sy]=toScreen(c.cx,c.cy);
        const along=av?sy:sx;
        if(along-lastPx<REPEAT)continue;
        const b=box(c.cx,c.cy,av?fs*1.5:w,av?w:fs*1.5);
        if(hit(b))continue;
        placed.push(b); lastPx=along;
        const e=s("text",{x:c.cx,y:c.cy,"text-anchor":"middle","dominant-baseline":"central",
          fill:"var(--road-text)","font-size":mpp()*fs,"letter-spacing":mpp()*fs*0.12,"font-weight":600,
          transform:av?`rotate(-90 ${c.cx} ${c.cy})`:null});
        e.textContent=nm; gRoadLbl.appendChild(e);
      }
    }
  }

  /* 6c. places - `big` first, then the rest. Pin always drawn; text may drop. */
  if(vis("pinBig")){
    const ps=[...W.places].sort((a,b)=>(b.big?1:0)-(a.big?1:0));
    for(const p of ps){
      if(!LIVE_NODES.has(p.at))continue;
      if(!p.big && !vis("pinSmall"))continue;
      const a=placeAnchor(p);
      if(!inView(a.x,a.y,60))continue;
      pin(p,a.x,a.y,placed,hit, p.big?vis("labelBig"):vis("labelSmallPlace"));
    }
  }

  /* 6d. building names - only real/poi until there is real room; ellipsis,
     never a bare cut like "E 44th Physica." */
  {
    const cands=W.buildings
      .filter(b=> b.real?vis("labelReal") : b.poi?vis("labelPoi") : vis("labelGeneric"))
      .sort((a,b)=>(b.real?2:b.poi?1:0)-(a.real?2:a.poi?1:0));
    for(const b of cands){
      const bb=blockBox(b.i,b.k);
      const x=bb.x+(b._x0+b._x1)/2*bb.w, y=bb.y+(b._y0+b._y1)/2*bb.h;
      if(!inView(x,y,40))continue;
      const lotW=m2p((b._x1-b._x0)*bb.w), lotH=m2p((b._y1-b._y0)*bb.h);
      const fs=Math.max(8.2,Math.min(12,Math.min(lotW*0.1,lotH*0.34)));
      const font=`${b.real?600:400} ${fs}px system-ui`;
      let txt=b.name;
      if(measure(txt,font)>lotW-8){
        if(lotW<62)continue;
        while(measure(txt+"…",font)>lotW-8&&txt.length>3)txt=txt.slice(0,-1);
        txt=txt.replace(/[ ,.]+$/,"")+"…";
      }
      const bx=box(x,y,measure(txt,font),fs*1.25);
      if(hit(bx))continue; placed.push(bx);
      const e=s("text",{x,y,"text-anchor":"middle","dominant-baseline":"central",
        fill:b.real?"var(--label)":"var(--label-dim)","font-size":mpp()*fs,
        "font-weight":b.real?600:400,stroke:"var(--halo)","stroke-width":mpp()*2,"paint-order":"stroke"});
      e.textContent=txt; gLabels.appendChild(e);
    }
  }
}
/* Category colour lives on a 12 px pin dot and nowhere else (spec 2.2). As tokens, not
   literals, so both themes can tune them and the "no colour literal in the SVG" rule holds
   without exceptions. */
const PIN={landmark:"var(--cat-landmark)",cultural:"var(--cat-landmark)",
  entrance:"var(--cat-transit)",transit:"var(--cat-transit)",hotel:"var(--cat-hotel)",
  restaurant:"var(--cat-food)",deli:"var(--cat-food)",bakery:"var(--cat-food)",
  market:"var(--cat-food)",clinic:"var(--cat-health)",pharmacy:"var(--cat-health)",
  park:"var(--cat-park)",library:"var(--cat-civic)",bookshop:"var(--cat-civic)",
  bank:"var(--cat-civic)",residential:"var(--cat-civic)"};
/* A place must never land in the roadway. Three strategies, in order:
   1. the place owns a building (building.poi === place.id) - sit on that
      building, which is where the door actually is;
   2. otherwise offset from the corner PERPENDICULAR to the street it is on
      AND along it, into the adjacent block. Offsetting on one axis only is
      exactly what leaves an entrance pin sitting on the avenue centreline;
   3. failing both, push into the nearest block quadrant. */
const BLD_BY_POI={};
for(const b of W.buildings) if(b.poi) BLD_BY_POI[b.poi]=b;
const SIDEV={N:[0,-1],S:[0,1],E:[1,0],W:[-1,0]};
function placeAnchor(p){
  const b=BLD_BY_POI[p.id];
  if(b){
    const bb=blockBox(b.i,b.k);
    return {x:bb.x+(b._x0+b._x1)/2*bb.w, y:bb.y+(b._y0+b._y1)/2*bb.h};
  }
  const [i,k]=W.nodes[p.at], v=SIDEV[p.side]||[0,0];
  let x=nodeX(i), y=nodeY(k);
  const offX=G.AV/2+G.BW*0.17, offY=G.ST/2+G.BH*0.17;
  if(v[0]){ x+=v[0]*offX; y+=(k<NST-1?1:-1)*offY; }
  else if(v[1]){ y+=v[1]*offY; x+=(i<NAV-1?1:-1)*offX; }
  else { x+=offX; y+=offY; }
  return {x,y};
}
function pin(p,x,y,placed,hit,withLabel){
  const c=PIN[p.cat]||"#9fb4c9", r=mpp()*(p.big?7:5), fs=p.big?11:10;
  if(withLabel){
    const font=`${p.big?600:400} ${fs}px system-ui`, w=measure(p.name,font);
    for(const [dx,dy] of RING){
      const ox=dx*(w/2+11)*mpp(), oy=dy*12*mpp();
      const b=box(x+ox,y+oy,w,fs*1.25);
      if(hit(b))continue; placed.push(b);
      const e=s("text",{x:x+ox,y:y+oy,"text-anchor":"middle","dominant-baseline":"central",
        fill:"var(--label)","font-size":mpp()*fs,"font-weight":p.big?600:400,
        stroke:"var(--halo)","stroke-width":mpp()*2.2,"paint-order":"stroke"});
      e.textContent=p.name; gLabels.appendChild(e); break;
    }
  }
  const g=s("g");
  g.appendChild(s("circle",{cx:x,cy:y,r:r*1.32,fill:"var(--halo)","fill-opacity":".85"}));
  g.appendChild(s("circle",{cx:x,cy:y,r,fill:c}));
  if(vis("pinGlyph")) g.appendChild(pinGlyph(p.cat,x,y,r*0.55,"var(--halo)"));
  else if(p.big) g.appendChild(s("circle",{cx:x,cy:y,r:r*0.36,fill:"var(--halo)","fill-opacity":".92"}));
  gLabels.appendChild(g);
}

/* ===========================================================================
   7. STATE - the only saturated colour on the map.
   =========================================================================== */
const HDEG={east:0,south:90,west:180,north:270};
function stateAt(t){
  let node=R.start_node,heading=R.start_facing,side=null,belief=null,say="";
  const walked=[R.start_node]; let dirs=[];
  /* legs[i] describes the walk that PRODUCED walked[i+1]. `closer` is replay.py's own verdict
     (did this move reduce the distance to the goal), which is the same computation that
     produces run.wrong_way_moves. Keeping it rather than re-deriving is the F1 guardrail. */
  const legs=[];
  for(const ev of TRACE){
    if(ev.t>t)break;
    if(ev.node)node=ev.node;
    if(ev.heading)heading=ev.heading;
    if(ev.side!=null)side=ev.side;
    if(ev.kind==="belief")belief={node:ev.believed_node,heading:ev.believed_heading,
      nodeOK:ev.node_correct,headOK:ev.heading_correct};
    if(ev.kind==="walk"){walked.push(ev.node);legs.push(ev);}
    if(ev.kind==="directions")dirs.push(ev);
    say=ev.text||say;
  }
  return {node,heading,side,belief,walked,legs,say,dirs,t};
}
function drawStateNow(){
  gState.textContent="";
  const st=stateAt(now);
  /* DEMO: the read-out used to be written at the very end of this function, below an early
     return that has already emptied the state layer. A trace touching a corner the graph
     does not carry therefore blanked the map AND left the read-out frozen on the previous
     step, so the page showed stale numbers beside an empty map. Painting it first means the
     worst case is a map without a walker, which at least does not lie. */
  const hname = GLIDE ? GLIDE.head : st.heading;
  paintStatus(st, hname);
  if(!LIVE_NODES.has(st.node))return;
  const [ni,nk]=W.nodes[st.node];
  /* DEMO: the glide enters here and only here. wx,wy is the single place the walker's
     position reaches the drawing, so interpolating it carries the field-of-view cone, the
     belief tether and the follow-camera along with the marker at no extra cost. */
  const wx    = GLIDE ? GLIDE.x    : nodeX(ni);
  const wy    = GLIDE ? GLIDE.y    : nodeY(nk);
  const hdeg  = GLIDE ? GLIDE.deg  : (HDEG[st.heading]??0);
  const t=TIER();

  /* 7a. field of view. The task is "describe what you can see", so showing
     which lots are actually in front of the walker makes the panel diagnostic
     rather than decorative. */
  const lit=new Set();
  if(showFov){
    const deg=hdeg, half=52, rad=t.fovRadius;   // DEMO: rotates with the glide
    const a0=(deg-half)*Math.PI/180,a1=(deg+half)*Math.PI/180;
    gState.appendChild(s("path",{d:`M ${wx} ${wy} L ${wx+Math.cos(a0)*rad} ${wy+Math.sin(a0)*rad}
      A ${rad} ${rad} 0 0 1 ${wx+Math.cos(a1)*rad} ${wy+Math.sin(a1)*rad} Z`,
      fill:"var(--route)","fill-opacity":".10",stroke:"var(--route)","stroke-opacity":".22","stroke-width":mpp()}));
    for(const b of W.buildings){
      const bb=blockBox(b.i,b.k);
      const bx=bb.x+(b._x0+b._x1)/2*bb.w, by=bb.y+(b._y0+b._y1)/2*bb.h;
      const dx=bx-wx,dy=by-wy,d=Math.hypot(dx,dy);
      if(d>rad)continue;
      let a=Math.atan2(dy,dx)*180/Math.PI-deg;
      while(a>180)a-=360; while(a<-180)a+=360;
      if(Math.abs(a)<=half)lit.add(bKey(b));
    }
  }
  /* DEMO: bug fix, plus a cache the fix makes necessary.
     gBldg's direct children are three wrapper groups (shadows, bodies, roofs); the rects
     carrying data-key sit one level further down, inside bodies. So this loop was writing
     fill="undefined" onto three <g> elements and lighting nothing: the "Field of view"
     building highlight has never worked. Querying the right level repairs it.
     Done naively that is ~240 setAttribute calls on every frame of a glide, so the node
     list is cached per building repaint and the writes are skipped whenever the lit set is
     unchanged, which it is for most of a block. */
  if(gBldg){
    if(LIT_NODES.g!==gBldg){
      LIT_NODES.g=gBldg;
      LIT_NODES.els=gBldg.querySelectorAll("rect[data-key]");
      LIT_PREV=null;
    }
    let sig=""; for(const k of lit)sig+=k+"|";   // insertion order is deterministic here
    if(sig!==LIT_PREV){
      LIT_PREV=sig;
      for(const r of LIT_NODES.els)
        r.setAttribute("fill",lit.has(r.dataset.key)?"var(--bldg-lit)":r.dataset.base);
    }
  }

  /* 7b. optimal route as a ghost; the walked path as the solid figure. The
     divergence between them IS the result - make it the strongest read. */
  const P=n=>{const[i,k]=W.nodes[n];return [nodeX(i),nodeY(k)];};
  /* Two ideal routes, drawn differently because on a blocked map they are DIFFERENT WALKS.
       IDEAL  green, medium dash - respects every closure. The walk actually being asked for.
       CLEAR  grey, fine dot     - ignores closures. What a router returns before it knows
                                   about the barricades, and what the copilot reaches for first.
     Only the clear one used to be drawn, which made a correct reroute look like a deviation.
     Both are diagnostic overlays and they overlap, so each has its own tile. */
  const drawRoute=(nodes,stroke,dash,w,op)=>{
    if(!(nodes&&nodes.length>1))return;
    const dd="M "+nodes.map(n=>P(n).join(" ")).join(" L ");
    gState.appendChild(s("path",{d:dd,fill:"none",stroke,"stroke-width":mpp()*(w+5.5),
      "stroke-opacity":".13","stroke-linecap":"round","stroke-linejoin":"round"}));
    gState.appendChild(s("path",{d:dd,fill:"none",stroke,"stroke-width":mpp()*w,
      "stroke-dasharray":dash,"stroke-opacity":op,
      "stroke-linecap":"round","stroke-linejoin":"round"}));
  };
  const IS_ERRAND = !!R.stop_node;
  if(IS_ERRAND){
    /* A two-leg errand has TWO ideal routes and they must not be merged: leg 1 is the walk the
       copilot is told about at pick-up, leg 2 only exists once the walker has arrived and asked.
       Drawing a single optimum start-to-final describes a journey nobody was ever asked to make.
       Leg 1 is the solid-ish dash, leg 2 the finer one, both green. */
    if(showIdeal){
      /* The WHOLE errand is drawn first in a darker leaf green, so the full plan is always
         visible as context. Then the leg the walker is CURRENTLY on is redrawn bright on top.
         Lighting both legs equally gave no clue which destination is live at this moment,
         which is the thing you are trying to read when scrubbing the timeline. */
      drawRoute(R.leg1_optimal_path,"var(--optimal-dim)",`${mpp()*6} ${mpp()*4.5}`,2.2,".95");
      drawRoute(R.leg2_optimal_path,"var(--optimal-dim)",`${mpp()*6} ${mpp()*4.5}`,2.2,".95");
      // Which leg is live: leg 2 from the moment the walker first stands on the errand stop.
      const onLeg2 = st.walked.includes(R.stop_node);
      drawRoute(onLeg2 ? R.leg2_optimal_path : R.leg1_optimal_path,
                "var(--optimal)",`${mpp()*7} ${mpp()*5}`,3.0,"1");
    }
  } else {
    const idealPath=(R.optimal_path_hindsight&&R.optimal_path_hindsight.length>1)
                    ?R.optimal_path_hindsight:R.optimal_path;
    const clearPath=R.optimal_path;
    const routesDiffer=JSON.stringify(idealPath)!==JSON.stringify(clearPath);
    if(showClear&&routesDiffer)
      drawRoute(clearPath,"var(--optimal-clear)",`${mpp()*4} ${mpp()*3.5}`,2.2,"1");
    if(showIdeal)
      drawRoute(idealPath,"var(--optimal)",`${mpp()*7} ${mpp()*5}`,2.6,"1");
  }
  // DEMO: the || clause. On the very first step `walked` is just [start], length 1, so the
  // whole trail block was skipped and the opening block of the walk drew no line at all.
  if(st.walked.length>1 || (GLIDE && GLIDE.partial)){
    /* The walked path is drawn ON THE PAVEMENT, offset to the RIGHT of travel, rather than
       down the middle of the roadway. Two problems fall out of the one change.

       1. The walker was drawn on the carriageway. The world has always known which corner they
          stand on; the renderer simply never used it, so a person who legally may only be on a
          pavement appeared to be walking up the centre of Lexington.
       2. A segment walked more than once was a single overdrawn line, so an out-and-back looked
          identical to a one-way trip. Offsetting by direction of travel means the outbound and
          return strands land on OPPOSITE sides of the street and separate visually, which is
          also how the two directions of pedestrian traffic actually flow.

       Repeat counts are only drawn once the zoom is close enough for the strands to be
       distinguishable - a x3 badge on a segment two pixels wide is noise, not information. */
    const KERB = () => Math.min(G.AV, G.ST) * 0.16;   // pavement offset from the centreline
    const legsOf = [];
    const seen = new Map();                            // "a|b" (unordered) -> traversals so far
    for (let i2 = 0; i2 < st.walked.length - 1; i2++) {
      const a = st.walked[i2], b = st.walked[i2 + 1];
      const key = [a, b].sort().join("|");
      const nth = (seen.get(key) || 0) + 1;
      seen.set(key, nth);
      legsOf.push({ a, b, nth, key, leg: 1 });
    }
    // Mark everything after the walker first stood on the errand stop as leg 2.
    if (R.stop_node) {
      let seenStop = false;
      for (const L of legsOf) {
        if (seenStop) L.leg = 2;
        if (L.b === R.stop_node) seenStop = true;
      }
    }
    const drawn = new Map();
    for (const L of legsOf) {
      const [ax, ay] = P(L.a), [bx, by] = P(L.b);
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const px = -uy, py = ux;                         // +90 degrees = right of travel
      // Successive re-walks in the SAME direction fan outward slightly so a third pass is
      // still visible rather than hidden under the first.
      const lane = KERB() * (1 + 0.55 * Math.floor((L.nth - 1) / 2));
      const ox = px * lane, oy = py * lane;
      const d = `M${ax + ox} ${ay + oy} L${bx + ox} ${by + oy}`;
      // On an errand the walk has two halves and they are different achievements. Leg 1 keeps
      // the familiar blue; leg 2 - the part the copilot only learns about mid-call - is violet,
      // so the seam is visible without reading the timeline.
      const col = (R.stop_node && L.leg === 2) ? "var(--leg2)" : "var(--route)";
      gState.appendChild(s("path", {d, fill: "none", stroke: col,
        "stroke-width": mpp() * 8, "stroke-opacity": ".18", "stroke-linecap": "round"}));
      gState.appendChild(s("path", {d, fill: "none", stroke: col,
        "stroke-width": mpp() * 3.0, "stroke-linecap": "round", filter: "url(#glow)"}));
      drawn.set(L.key, Math.max(drawn.get(L.key) || 0, L.nth));
    }
    /* DEMO: the part-walked block. Without it the marker glides out ahead of its own trail
       and the line snaps in a whole block behind, which reads as the map lagging the walker.
       It is drawn from the corner just left to wherever the walker currently is, and it
       reuses the in-scope `seen` counter so it lands in exactly the lane the finished leg
       will occupy - otherwise the strand would jump sideways the moment the step completed.
       Deliberately NOT recorded in `drawn`: a x2 badge must not flash up five percent into
       a re-walk. */
    if (GLIDE && GLIDE.partial && W.nodes[GLIDE.fromNode] && W.nodes[GLIDE.toNode]) {
      const [pax, pay] = P(GLIDE.fromNode), [pbx, pby] = P(GLIDE.toNode);
      const pdx = pbx - pax, pdy = pby - pay, plen = Math.hypot(pdx, pdy) || 1;
      const ppx = -pdy / plen, ppy = pdx / plen;          // +90 degrees = right of travel
      const pkey = [GLIDE.fromNode, GLIDE.toNode].sort().join("|");
      const pnth = (seen.get(pkey) || 0) + 1;
      const plane = KERB() * (1 + 0.55 * Math.floor((pnth - 1) / 2));
      const pox = ppx * plane, poy = ppy * plane;
      const pd = `M${pax + pox} ${pay + poy} L${GLIDE.x + pox} ${GLIDE.y + poy}`;
      const pcol = (R.stop_node && GLIDE.leg === 2) ? "var(--leg2)" : "var(--route)";
      gState.appendChild(s("path", {d: pd, fill: "none", stroke: pcol,
        "stroke-width": mpp() * 8, "stroke-opacity": ".18", "stroke-linecap": "round"}));
      gState.appendChild(s("path", {d: pd, fill: "none", stroke: pcol,
        "stroke-width": mpp() * 3.0, "stroke-linecap": "round", filter: "url(#glow)"}));
    }
    // x2, x3 badges at the midpoint, only when a block is wide enough on screen to read
    const blockPx = Math.min(G.AV, G.ST) / mpp();
    if (blockPx > 90) {
      for (const [key, n] of drawn) {
        if (n < 2) continue;
        const [a, b] = key.split("|");
        if (!W.nodes[a] || !W.nodes[b]) continue;
        const [ax, ay] = P(a), [bx, by] = P(b);
        const mx = (ax + bx) / 2, my = (ay + by) / 2, r = mpp() * 7.5;
        gState.appendChild(s("circle", {cx: mx, cy: my, r, fill: "var(--ground)",
          "fill-opacity": ".92", stroke: "var(--route)", "stroke-width": mpp() * 1.8}));
        const e = s("text", {x: mx, y: my + mpp() * 3.4, "text-anchor": "middle",
          fill: "var(--route)", "font-size": mpp() * 9.5, "font-weight": 700});
        e.textContent = "\u00d7" + n;
        gState.appendChild(e);
      }
    }
  }
  /* Closures. The hatched band alone was easy to miss at low zoom and gave no clue WHERE the
     barricade starts and stops, which is the thing a reader is trying to work out when a
     reroute looks wrong. Each closed segment now also gets a stop bar across the pavement at
     BOTH ends - the actual point the walker is turned back - and a barrier glyph at the middle
     so the segment reads as shut even when the band is only a few pixels wide. */
  for(const cid of R.closed_segments||[]){
    const sg=W.segments.find(x=>x.id===cid); if(!sg)continue;
    const a=P(sg.from),b=P(sg.to);
    gState.appendChild(s("line",{x1:a[0],y1:a[1],x2:b[0],y2:b[1],
      stroke:"var(--closed)","stroke-width":mpp()*9,"stroke-opacity":".16"}));
    gState.appendChild(s("line",{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:"url(#hatch)","stroke-width":mpp()*8}));
    const dx=b[0]-a[0], dy=b[1]-a[1], L=Math.hypot(dx,dy)||1;
    const ux=dx/L, uy=dy/L, px=-uy, py=ux;          // along, and perpendicular
    const barHalf=mpp()*7, inset=mpp()*9;
    for(const [ex,ey,sgn] of [[a[0],a[1],1],[b[0],b[1],-1]]){
      const cx=ex+ux*inset*sgn, cy=ey+uy*inset*sgn;
      gState.appendChild(s("line",{x1:cx+px*barHalf,y1:cy+py*barHalf,
        x2:cx-px*barHalf,y2:cy-py*barHalf,stroke:"var(--closed)",
        "stroke-width":mpp()*3,"stroke-linecap":"round"}));
    }
    const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2, r=mpp()*8;
    gState.appendChild(s("circle",{cx:mx,cy:my,r,fill:"var(--ground)","fill-opacity":".9",
      stroke:"var(--closed)","stroke-width":mpp()*2}));
    for(const k of [-1,1]){
      gState.appendChild(s("line",{x1:mx-r*0.5,y1:my+k*r*0.45,x2:mx+r*0.5,y2:my+k*r*0.45,
        stroke:"var(--closed)","stroke-width":mpp()*1.9,"stroke-linecap":"round"}));
    }
  }

  /* 7c-pre. THE ERRAND STOP. A two-leg walk has an intermediate goal that is not the end of
     the task, and drawing it with the same gold star as the destination - or not at all, as
     before - makes the whole condition unreadable: you cannot see where leg 1 finished and
     leg 2 began. A violet ringed pin, matching the leg-2 path colour, with a tick once the
     walker has actually reached it. */
  if(R.stop_node && LIVE_NODES.has(R.stop_node)){
    const [sx,sy]=P(R.stop_node), r=mpp()*8;
    const done = !!R.reached_stop;
    gState.appendChild(s("circle",{cx:sx,cy:sy,r:r*2.0,fill:"var(--leg2)","fill-opacity":".13"}));
    gState.appendChild(s("circle",{cx:sx,cy:sy,r,fill:done?"var(--leg2)":"var(--ground)",
      stroke:"var(--leg2)","stroke-width":mpp()*2.2}));
    if(done){
      gState.appendChild(s("path",{d:`M${sx-r*0.42} ${sy} L${sx-r*0.08} ${sy+r*0.38} L${sx+r*0.45} ${sy-r*0.34}`,
        fill:"none",stroke:"var(--halo)","stroke-width":mpp()*2,"stroke-linecap":"round",
        "stroke-linejoin":"round"}));
    }
    if(showLabels){
      const e=s("text",{x:sx,y:sy-mpp()*13,"text-anchor":"middle",fill:"var(--leg2)",
        "font-size":mpp()*10,"font-weight":600,stroke:"var(--halo)","stroke-width":mpp()*2.4,
        "paint-order":"stroke"});
      e.textContent="stop 1: "+(R.stop_name||"errand");
      gState.appendChild(e);
    }
  }

  /* 7c. destination */
  const dest=W.places.find(p=>p.id===R.destination_id)||
             W.places.find(p=>p.name?.includes("Lexington Avenue entrance"));
  if(dest&&LIVE_NODES.has(dest.at)){
    const [dx,dy]=P(dest.at), r=mpp()*8;
    gState.appendChild(s("circle",{cx:dx,cy:dy,r:r*1.9,fill:"var(--dest)","fill-opacity":".14"}));
    gState.appendChild(s("path",{d:star(dx,dy,r,r*.44,5),fill:"var(--dest)",
      stroke:"var(--halo)","stroke-width":mpp()}));
  }

  /* 7d. belief - ONE marker, always at the copilot's BELIEVED position.

     The old version drew two amber circles and joined them with a dotted line whenever the
     believed corner was wrong, and drew a second dotted ring around the WALKER whenever the
     heading was unknown. That said the opposite of what was meant: a ring around the walker
     implies the copilot believes they are there, and two rings implies two beliefs. It also
     conflated "position unknown" with "heading unknown", which are the two states this world
     exists to separate.

     Now: one ring at the believed corner. SOLID when the copilot has stated a heading, DOTTED
     when it has not. A triangle points along the believed heading and simply is not drawn when
     there is no heading to point along, so the marker collapses to a bare ring. Position and
     heading each have exactly one visual channel and neither can be mistaken for the other. */
  if(showBelief&&st.belief){
    const bn=st.belief.node&&LIVE_NODES.has(st.belief.node)?st.belief.node:null;
    if(bn){
      const [bx,by]=P(bn);
      const head=st.belief.heading||null;
      const wrongNode=bn!==st.node, wrongHead=head&&head!==st.heading;
      const r=mpp()*12;
      if(head){
        gState.appendChild(arrow(bx,by,HDEG[head]??0,mpp()*26,"var(--belief)",mpp()*3.2));
      }
      gState.appendChild(s("circle",Object.assign(
        {cx:bx,cy:by,r,fill:"var(--ground)","fill-opacity":".35",stroke:"var(--belief)",
         "stroke-width":mpp()*(head?2.4:1.9)},
        head?{}:{"stroke-dasharray":`${mpp()*4} ${mpp()*3.4}`})));
      const e=s("text",{x:bx,y:by-mpp()*20,"text-anchor":"middle",fill:"var(--belief)",
        "font-size":mpp()*10,"font-weight":600,stroke:"var(--halo)","stroke-width":mpp()*2.4,
        "paint-order":"stroke"});
      e.textContent = !head ? "copilot: position only, no heading"
                    : wrongHead ? `copilot: facing ${head} (wrong)`
                    : `copilot: facing ${head}`;
      gState.appendChild(e);
      if(wrongNode){
        // a thin tether ONLY when the believed corner differs from the real one, so the
        // reader can see how far off the copilot is without a second circle implying a
        // second belief
        gState.appendChild(s("line",{x1:bx,y1:by,x2:wx,y2:wy,stroke:"var(--belief)",
          "stroke-width":mpp()*1.2,"stroke-dasharray":`${mpp()*3} ${mpp()*3}`,
          "stroke-opacity":".55"}));
      }
    }
  }

  /* 7e. walker */
  gState.appendChild(arrow(wx,wy,hdeg,mpp()*28,"var(--route)",mpp()*4));   // DEMO: tweened
  gState.appendChild(s("circle",{cx:wx,cy:wy,r:mpp()*10,fill:"var(--route)","fill-opacity":".2"}));
  gState.appendChild(s("circle",{cx:wx,cy:wy,r:mpp()*5.8,fill:"var(--route)",stroke:"var(--halo)","stroke-width":mpp()*1.8}));
  const l=s("text",{x:wx,y:wy+mpp()*19,"text-anchor":"middle",fill:"var(--route)","font-size":mpp()*10,
    "font-weight":600,stroke:"var(--halo)","stroke-width":mpp()*2.4,"paint-order":"stroke"});
  l.textContent=`walker: facing ${hname}`; gState.appendChild(l);

  /* DEMO: the camera is held still during the loop's cut back to the start. Letting the
     leash run there would whip the view across the whole map, which reads as a second walk
     rather than a restart. paintStatus has moved to the top of this function. */
  if(follow && !REWINDING)leash(wx,wy,hname);
}
/* DEMO: a rAF-coalescing wrapper. The renderer calls drawState() from about twenty places,
   several of which fire in bursts (pointermove, ResizeObserver, a toggle that also redraws
   labels). Coalescing means a burst costs one repaint instead of five. The glide loop calls
   drawStateNow() directly, since it is already inside a frame. */
let _stateQueued=0;
function drawState(){
  if(_stateQueued)return;
  _stateQueued=requestAnimationFrame(()=>{_stateQueued=0;drawStateNow();});
}
function arrow(x,y,deg,len,col,w){
  const a=deg*Math.PI/180,x2=x+Math.cos(a)*len,y2=y+Math.sin(a)*len,hw=w*1.9,g=s("g");
  g.appendChild(s("line",{x1:x,y1:y,x2,y2,stroke:col,"stroke-width":w,"stroke-linecap":"round"}));
  g.appendChild(s("path",{d:`M ${x2+Math.cos(a)*hw} ${y2+Math.sin(a)*hw}
    L ${x2-Math.cos(a-.62)*hw*1.5} ${y2-Math.sin(a-.62)*hw*1.5}
    L ${x2-Math.cos(a+.62)*hw*1.5} ${y2-Math.sin(a+.62)*hw*1.5} Z`,fill:col}));
  return g;
}
function star(cx,cy,R_,r_,n){let d="";
  for(let i=0;i<n*2;i++){const a=i*Math.PI/n-Math.PI/2,rr=i%2?r_:R_;
    d+=(i?"L":"M")+(cx+Math.cos(a)*rr)+" "+(cy+Math.sin(a)*rr)+" ";}
  return d+"Z";}
/* Follow camera. Two things every navigation UI does and hand-rolled ones
   usually miss:
   1. LEASH - recentre only when the walker leaves the inner 42% of the frame.
      Recentring every frame is what makes a follow-cam feel sickening.
   2. LOOK-AHEAD - aim at a point in front of the walker, not at the walker.
      You want to see where they are going, and it stops the walker sitting on
      the edge of the modelled area with half the frame empty. */
function leash(x,y,heading){
  /* RE-CENTRE, dead centre, no look-ahead.

     The old camera aimed a fraction of a screen IN FRONT of the walker, which is what a driving
     satnav does because a car keeps going the way it points. A walker on a phone does not: they
     stand still for most of the call and then turn and move, so the look-ahead spent the whole
     conversation biased toward a heading that was about to change, and every turn snapped the
     frame. Centring on the walker is both simpler and correct for this motion.

     Follow must never fight a zoom in flight, so it recentres toward the zoom's TARGET scale,
     not the half-animated one, or every zoom click gets eaten. */
  const v=TGT.v, halfW=v/2, halfH=vh()/2;
  let tx=x, ty=y;

  /* Keep the viewport inside the world plus a margin, so a walker on the boundary is pulled
     INTO frame rather than sitting against the edge with half the frame off-world. When the
     world is narrower than the viewport there is nothing to clamp, so centre on the world. */
  const PAD=Math.min(halfW,halfH)*0.22;
  const loX=-PAD+halfW, hiX=MW()+PAD-halfW;
  const loY=-PAD+halfH, hiY=MH()+PAD-halfH;
  tx = loX>hiX ? MW()/2 : Math.max(loX,Math.min(hiX,tx));
  ty = loY>hiY ? MH()/2 : Math.max(loY,Math.min(hiY,ty));

  /* Small dead zone so a single block does not jerk the camera, but much tighter than before:
     the walker should read as parked in the middle, not drifting to a corner. */
  const off=Math.abs((x-TGT.x)/halfW)>.16 || Math.abs((y-TGT.y)/halfH)>.16;
  if(off) easeTo(v,tx,ty,520);
}

/* ===========================================================================
   8. GLUE
   =========================================================================== */
const redrawZoom=()=>{drawBuildings();drawLabels();drawState();};
/* DEMO: trimmed to the thin read-out this page wants, and gated.
   Two changes. First, the errand leg pills, the belief-accuracy percentage and the
   directions rail are gone: this page shows the world and the walk, not the conversation.
   The current action moved up into the strip, since the spoken line it used to live on has
   been removed. Second, it is now called on every animation frame, and it writes innerHTML,
   so an unguarded version would reparse the strip sixty times a second and make the text
   impossible to select. The signature check means it only writes when something changed. */
let _statusSig=null;
function paintStatus(st, hname){
  const b=st.belief;
  const bad = b && ((b.headOK===false)||(b.nodeOK===false));
  const blocks = st.walked.length-1;
  const sig = `${st.node}|${hname}|${blocks}|${ACTION}|${bad}`;
  if(sig===_statusSig)return;
  _statusSig=sig;
  $el("status").innerHTML=`
    <span class="pill ${R.arrived?"ok":"bad"}">${R.arrived?"Delivered":(R.termination_reason||"not delivered")}</span>
    <span>at <b>${W.corner_names[st.node]||st.node}</b> facing <b>${hname}</b></span>
    <span>blocks <b>${blocks}</b> / ${R.optimal_blocks_clear} optimal</span>
    <span>wrong-way moves <b>${R.wrong_way_moves??0}</b></span>
    ${bad?`<span style="color:var(--belief)">copilot belief diverges</span>`:``}
    <span class="act">${ACTION||st.say||""}</span>`;
}
function scalebar(){
  let best=10;
  for(const v of [10,20,25,50,100,200,250,500,1000,2000]) if(m2p(v)<=100) best=v;
  $el("sbTrack").style.width=m2p(best).toFixed(0)+"px";
  $el("sbTxt").textContent=best>=1000?best/1000+" km":best+" m";
}
/* Belief is a per-run FACT, not a feature of the map: a run whose copilot never states a
   position emits no belief events, and on those runs the swatch and its toggle described
   something the reader could never see. Both are gated on the trace actually carrying one. */
const HAS_BELIEF=(GEO&&GEO.trace||[]).some(e=>e&&e.kind==="belief");
if(!HAS_BELIEF){const tb=$el("tBelief");if(tb)tb.hidden=true;}
$el("legend").innerHTML=[["var(--bldg-3)","named"],["var(--bldg-2)","POI"],
  ["var(--bldg)","fill"],["var(--bldg-lit)","in view"],["var(--route)","walked"],
  ["var(--optimal)","current leg"],["var(--optimal-dim)","whole route"],["var(--optimal-clear)","route if clear"],["var(--leg2)","leg 2 walked"],...(HAS_BELIEF?[["var(--belief)","belief"]]:[]),
  ["var(--dest)","destination"]].map(([c,t])=>`<span><i style="background:${c}"></i>${t}</span>`).join("");

let drag=null;
svg.addEventListener("pointerdown",e=>{drag={x:e.clientX,y:e.clientY,cx:CX,cy:CY};
  svg.setPointerCapture(e.pointerId);svg.classList.add("drag");setFollow(false);USERCAM=true;});
svg.addEventListener("pointermove",e=>{if(!drag)return;
  CX=drag.cx-(e.clientX-drag.x)*mpp();CY=drag.cy-(e.clientY-drag.y)*mpp();
  TGT={v:VIEW,x:CX,y:CY};
  writeView();drawLabels();drawState();});
svg.addEventListener("pointerup",()=>{drag=null;svg.classList.remove("drag");});
/* DEMO: not in a compact tile. The tile is a thumbnail with every control hidden, and on the
   flight page six of them fill most of a scroll-driven column - so a non-passive handler that
   always preventDefault()s meant a wheel over the evidence scrolled nothing at all. Measured:
   four notches over a tile moved the page 0px, the same four over the prose moved it 480px.
   Zooming is still available: click the tile and the full renderer opens with its own map. */
svg.addEventListener("wheel",e=>{if(COMPACT)return;e.preventDefault();setFollow(false);USERCAM=true;
  const r=svg.getBoundingClientRect();
  const mx=CX-VIEW/2+((e.clientX-r.left)/r.width)*VIEW, my=CY-vh()/2+((e.clientY-r.top)/r.height)*vh();
  const nv=Math.max(130,Math.min(Math.max(MW(),MH())*1.5,VIEW*Math.exp(e.deltaY*0.0016))), k=nv/VIEW;
  CX=mx+(CX-mx)*k; CY=my+(CY-my)*k; VIEW=nv; TGT={v:VIEW,x:CX,y:CY};
  writeView(); redrawZoom();},{passive:false});

const setFollow=v=>{follow=v;$el("follow").classList.toggle("on",v);};
$el("follow").onclick=()=>{USERCAM=true;setFollow(!follow);if(follow)drawState();};
/* Zooming out must reveal the two things the reader is trying to relate: where the walker is
   NOW and where they are trying to get to. The old handlers ignored both - "Whole map" jumped
   to the geometric centre of the world at a fixed scale, and "-" scaled around whatever the
   centre happened to be, so zooming out could sail away from the walker entirely. Both now
   frame CONTENT. */
function runPoints(){
  const st=stateAt(now), pts=[];
  const P_=n=>{const c=W.nodes[n]; return c?[nodeX(c[0]),nodeY(c[1])]:null;};
  const push=n=>{const p=n&&P_(n); if(p)pts.push(p);};
  push(st.node);                                  // where they are now
  const dest=W.places.find(p=>p.id===R.destination_id)
          || W.places.find(p=>p.name?.includes("Lexington Avenue entrance"));
  if(dest)push(dest.at);                          // where they are going
  (st.walked||[]).forEach(push);                  // and everything walked so far
  return pts;
}
/* DEMO: every corner the walk touches, plus the whole ideal route and the destination.
   runPoints() above frames what has happened SO FAR, which is right for the "Whole map"
   button mid-walk but wrong for the opening frame: on step one it knows only the start
   corner. Framing on the journey instead means the entire trip is on screen from the first
   frame, which is the whole point of the page. You see where the walker began, where they
   are trying to get to, and the shape of the route between, and then you watch them cover
   it. */
function journeyPoints(){
  const pts=[], P_=n=>{const c=W.nodes[n]; return c?[nodeX(c[0]),nodeY(c[1])]:null;};
  const push=n=>{const p=n&&P_(n); if(p)pts.push(p);};
  for(const e of TRACE) push(e.node);
  (R.optimal_path||[]).forEach(push);
  (R.optimal_path_hindsight||[]).forEach(push);
  const dest=W.places.find(p=>p.id===R.destination_id)
          || W.places.find(p=>p.name?.includes("Lexington Avenue entrance"));
  if(dest)push(dest.at);
  return pts;
}
/* Same idea as fitTo but instant, and it claims more of the frame. fitTo reserves nearly
   half the height for a floating control panel that, on this page, is a single small bar in
   one corner. Easing here would also mean the page visibly swoops on load. */
function fitJourney(){
  const pts=journeyPoints(); if(!pts.length)return;
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
  const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  /* DEMO: a tile gets more margin than the full page does. The belief and walker labels are
     drawn beside their markers, and on a small panel a marker sitting one block from the edge
     puts its label half outside the box. */
  const padF = COMPACT ? 3.0 : 1.8;
  const needW=((x1-x0)+G.AV*padF)/0.86;
  const needH=((y1-y0)+G.ST*padF)/0.74;
  const aspect=vh()/Math.max(1,VIEW);
  const want=Math.max(240, needW, needH/Math.max(0.01,aspect));

  /* Seeing the whole journey is worth a lot, but not at any price. A viewport is wide and
     short while a walk that walks the long way round is tall, so framing it all can demand a
     zoom well past the point where roofs, crosswalks and place labels stop drawing, and the
     page then shows a flat diagram rather than a city. So: frame the whole journey when it
     fits at a readable zoom, and when it does not, hold the readable zoom and let the camera
     follow the walker instead. The "Whole map" button still gives the overview on demand.
     LIMIT is the width at which a block is about 250 screen pixels, the bottom of the tier
     that still draws roofs. */
  /* DEMO: a gallery tile is a diagram, not a reading surface. Nobody inspects a roof in a
     280 pixel card, and a tile that follows the walker shows six close-ups of asphalt instead
     of six shapes. So a tile always frames the whole journey, whatever that costs in detail. */
  const LIMIT=COMPACT ? Infinity : G.BW*px()/250;
  if(anim){cancelAnimationFrame(anim);anim=null;}
  VIEW=Math.min(want, LIMIT, Math.max(MW(),MH())*1.6);
  setFollow(want>LIMIT);

  /* Centre on the middle of the route, or on the walker when the camera is going to follow,
     so the first thing the page does is not a slide. */
  let cx0=(x0+x1)/2, cy0=(y0+y1)/2;
  if(follow && W.nodes[R.start_node]){
    const [si,sk]=W.nodes[R.start_node]; cx0=nodeX(si); cy0=nodeY(sk);
  }
  /* Then pull that centre back inside the world. A walk near an edge of the map centres on
     itself and spends a quarter of the frame on the grey nothing beyond the last street,
     which reads as a rendering fault rather than as the edge of the world. Once the frame is
     wider than the world there is no edge left to avoid, so centre on the world itself. */
  const hw=VIEW/2, hh=vh()/2, pad=G.AV;
  CX = MW()>VIEW ? Math.max(hw-pad, Math.min(MW()-hw+pad, cx0)) : MW()/2;
  CY = MH()>vh() ? Math.max(hh-pad, Math.min(MH()-hh+pad, cy0)) : MH()/2;
  TGT={v:VIEW,x:CX,y:CY};
  writeView(); drawBuildings(); drawLabels(); drawStateNow();
}
function fitTo(pts,ms=460,minView=200){
  /* Frame every point inside the CENTRAL area of the viewport, not merely inside its bounds.

     The old version fitted the bounding box to the full frame, so the walker and destination
     ended up hard against the edges - one of them behind the floating control panel, the other
     half off screen, and the route between them unreadable. Two fixes: reserve the top strip
     the panel occupies and a matching strip at the bottom, and then fit into the remaining
     centre with a real margin on all four sides. */
  if(!pts.length)return;
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
  const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  const cx=(x0+x1)/2, cy=(y0+y1)/2;

  /* Fraction of the frame the content may occupy. 0.62 across and 0.52 down leaves roughly a
     fifth of the height clear top and bottom, which is what the control panel needs plus room
     for the place labels that hang off the pins. */
  const USE_W=0.62, USE_H=0.52;
  const needW=((x1-x0)+G.AV*0.9)/USE_W;
  const needH=((y1-y0)+G.ST*0.9)/USE_H;

  /* VIEW is the frame WIDTH in world units; the height follows from the element's aspect
     ratio. To fit a required height, convert it to the width that produces it:
     width = height / aspect, where aspect = vh()/VIEW. */
  const aspect=vh()/Math.max(1,VIEW);
  const v=Math.max(minView, needW, needH/Math.max(0.01,aspect));
  easeTo(Math.min(v,Math.max(MW(),MH())*1.6),cx,cy,ms);
}
$el("zin").onclick=()=>{USERCAM=true;easeTo(Math.max(130,VIEW/1.7),CX,CY);};
$el("zout").onclick=()=>{
  USERCAM=true;
  const v=Math.min(Math.max(MW(),MH())*1.5,VIEW*1.7);
  /* Keep the walker and the destination inside the wider frame: recentre on their midpoint
     when the new view is big enough to hold both, otherwise stay put and just widen. */
  const pts=runPoints();
  if(pts.length){
    const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
    const cx=(Math.min(...xs)+Math.max(...xs))/2, cy=(Math.min(...ys)+Math.max(...ys))/2;
    const spanX=Math.max(...xs)-Math.min(...xs), spanY=Math.max(...ys)-Math.min(...ys);
    const aspect=vh()/Math.max(1,VIEW);
    if(spanX<=v*0.9 && spanY<=v*aspect*0.9){ easeTo(v,cx,cy); return; }
  }
  easeTo(v,CX,CY);
};
// DEMO: reframes the whole journey, not just what has been walked so far.
$el("all").onclick=()=>{USERCAM=false;setFollow(false);fitJourney();};
$el("tIdeal").onclick=e=>{showIdeal=!showIdeal;e.target.classList.toggle("on",showIdeal);drawState();};
$el("tClear").onclick=e=>{showClear=!showClear;e.target.classList.toggle("on",showClear);drawState();};
$el("tFov").onclick=e=>{showFov=!showFov;e.target.classList.toggle("on",showFov);drawState();};
$el("tBelief").onclick=e=>{showBelief=!showBelief;e.target.classList.toggle("on",showBelief);drawState();};
$el("tLabels").onclick=e=>{showLabels=!showLabels;e.target.classList.toggle("on",showLabels);drawLabels();};
$el("tAspect").onclick=e=>{
  const isTrue=G===GEOM.true_;
  const fx=(CX-0)/MW(), fy=(CY-0)/MH(), fv=VIEW/MW();
  G=isTrue?GEOM.square:GEOM.true_;
  e.target.classList.toggle("on",!isTrue);
  e.target.textContent=isTrue?"True proportions":"Square blocks";
  CX=fx*MW(); CY=fy*MH(); VIEW=fv*MW();
  drawBase(); writeView(); redrawZoom();
};
/* The map's own light/dark switch.
   This was inert. The reference page owned an id="theme" button that the visualizer does not
   render, so `$el("theme")` fell through to a SINK - a detached <span> - and the handler was
   bound to an element that is not in the document and can never be clicked. The body was a
   no-op too: it computed `l` and then only rewrote the label, never adding or removing a class.
   Meanwhile the REAL control, the `tTheme` tile, had no handler at all, and mapTheme() was
   defined but never called. Bind the real button, and honour the stored preference on load so
   the choice survives a reload and a jump between trials. */
$el("tTheme").onclick=()=>{
  mapTheme(root.classList.contains("wm-light") ? "dark" : "light");
};
/* DEMO: a saved choice wins; failing that, follow the host. A dark map is the default this
   page was built around, but when it is embedded somewhere that has already declared a light
   theme, opening dark reads as a page that ignored the request. The sun button still overrides
   either way, and once pressed the choice is remembered. */
mapTheme(
  localStorage.getItem("duplexworld-theme")
  || (document.documentElement.dataset.theme === "light"
      || (!document.documentElement.dataset.theme
          && window.matchMedia
          && matchMedia("(prefers-color-scheme: light)").matches)
      ? "light" : "dark"));

/* DEMO: the standalone reference page's own continuous-time transport used to sit here.
   It was already dead in the shipped renderer: every element it touches (seek, play, speed,
   tnum, tdur) resolves to a detached sink span, so the handler could never fire and the
   speed multiplier always read zero. Deleted rather than left to confuse, and its `DUR`
   identifier was colliding with the new one anyway. */



  // ---- audit hooks --------------------------------------------------------------------
  // The renderer lives in a closure, so the audit rubric cannot reach VIEW/tierName/etc from
  // the console. Expose exactly the read-only probes the rubric needs, and nothing that can
  // mutate a metric. Sweeps restore the view they started from.
  window.__wmAudit = {
    W, R, TRACE,
    tierName: () => tierName(),
    sweepTiers() {
      const v0 = VIEW, x0 = CX, y0 = CY, seen = new Set();
      for (let v = 130; v <= Math.max(MW(), MH()) * 1.5; v *= 1.25) {
        VIEW = v; TGT = { v, x: CX, y: CY }; writeView(); redrawZoom();
        seen.add(tierName());
      }
      VIEW = v0; CX = x0; CY = y0; TGT = { v: VIEW, x: CX, y: CY };
      writeView(); redrawZoom();
      return [...seen];
    },
    sweepState() {
      const v0 = VIEW, x0 = CX, y0 = CY; let missing = 0;
      for (let v = 130; v <= Math.max(MW(), MH()) * 1.5; v *= 1.4) {
        VIEW = v; TGT = { v, x: CX, y: CY }; writeView(); redrawZoom(); drawState();
        if (!svg.querySelector("#state circle")) missing++;
      }
      VIEW = v0; CX = x0; CY = y0; TGT = { v: VIEW, x: CX, y: CY };
      writeView(); redrawZoom(); drawState();
      return missing;
    },
    repaint() { drawBase(); writeView(); redrawZoom(); drawState(); },
    getView: () => VIEW,
    getTarget: () => TGT.v,
    setNow(t) { now = t; drawState(); },
    usesMeasureText: true,
    markersInRoad() {
      const bad = [];
      for (const p of W.places) {
        if (!LIVE_NODES.has(p.at)) continue;
        const a = placeAnchor(p), [i, k] = W.nodes[p.at];
        if (Math.abs(a.x - nodeX(i)) < G.AV / 2 && Math.abs(a.y - nodeY(k)) < G.ST / 2)
          bad.push(p.name);
      }
      return bad;
    },
  };

  // ---- bootstrap ---------------------------------------------------------------------
  svg.appendChild(defs());
  gBase    = s("g", { id: "base" });    svg.appendChild(gBase);
  gRoadLbl = s("g", { id: "roadlbl" }); svg.appendChild(gRoadLbl);
  gLabels  = s("g", { id: "labels" });  svg.appendChild(gLabels);
  gState   = s("g", { id: "state" });   svg.appendChild(gState);
  { const [i, k] = W.nodes[R.start_node]; CX = nodeX(i); CY = nodeY(k); }

  /* DEMO: open on the whole journey with the camera parked, rather than zoomed in on the
     start corner with the camera chasing the walker. Both the start and the destination are
     then on screen for the entire loop, so a viewer who glances at the page for four seconds
     still sees the shape of the problem. The re-centre button turns following back on for
     anyone who wants the close view. */
  requestAnimationFrame(() => {
    drawBase(); writeView(); redrawZoom();
    fitJourney();          // decides the zoom, and whether the camera follows
  });
  // DEMO: a parked camera must re-frame when the window changes shape, or the journey
  // ends up half off screen. Skipped once the viewer has taken the camera by hand.
  /* DEMO: a slide that expands fires this on every frame of a 620 ms animation, times six
     instances. fitJourney re-runs the label collision solver and rebuilds every roof, which is
     far too much to do sixty times a second. So while the box is moving, only the cheap view
     write happens, and the real re-frame lands once the size settles. */
  let roT = 0;
  const ro = new ResizeObserver(() => {
    // The timeline is a canvas, so a width change is a repaint, not a rescale.
    if (typeof drawTL === "function") drawTL();
    if (COMPACT) {
      writeView();
      clearTimeout(roT);
      roT = setTimeout(() => {
        roT = 0;
        if (!USERCAM && !follow) fitJourney(); else redrawZoom();
      }, 140);
      return;
    }
    if (!USERCAM && !follow) { fitJourney(); return; }
    writeView(); redrawZoom();
  });
  ro.observe(svg);


  /* ---- DEMO transport: an endless, smoothly glided walk --------------------------------
     The shipped renderer had two clocks: a one-shot 850 ms setInterval that snapped from
     stop to stop, and the visualizer's audio timeline, which overrode it. Both are gone.
     What replaces them is a single rAF loop over the stops, and one important change of
     coordinate: playback advances over STOP INDEX, not over trace seconds.

     That is forced, not a preference. The real gaps between stops are thinking and talking
     time: the clean run goes start t=0, turn t=50.0, walk t=50.2. A 50 second pause and
     then two stops inside a fifth of a second. Played on the real clock the walker stands
     frozen for a minute and then teleports. Played on index, each step takes the time a
     step should take and the walk reads as a walk. Nothing measured is affected: the trace,
     the routes and every number on screen are untouched, only the pacing is ours. */
  const STOPS = TRACE.filter(e =>
    ["start", "walk", "turn", "cross", "refused", "blocked", "deadend"].includes(e.kind));

  /* Per-transition durations. A step classified on what actually CHANGED rather than on the
     event kind, because stateAt() folds node and heading from every event and the delta is
     what is being animated. */
  const DUR = { move: 1200, turn: 400, beat: 520 };
  const SEGS = [];
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i], b = STOPS[i + 1];
    const moved  = a.node    && b.node    && b.node    !== a.node;
    const turned = a.heading && b.heading && b.heading !== a.heading;
    const kind = moved ? "move" : turned ? "turn" : "beat";
    /* Shortest arc, so west 180 to north 270 rotates through 225 and not backwards through
       zero. Every quarter turn is unambiguous; only turn_around is a genuine coin flip, and
       replay.py already wrote the answer into the event text, so read it rather than guess. */
    let d = (((HDEG[b.heading] ?? 0) - (HDEG[a.heading] ?? 0) + 540) % 360) - 180;
    if (Math.abs(Math.abs(d) - 180) < 1e-6) d = /right/i.test(b.text || "") ? 180 : -180;
    SEGS.push({ kind, ms: DUR[kind], dTurn: d });
  }

  let pos = 0, stepIdx = 0;
  const sRange = $el("sRange"), sLabel = $el("sLabel"), sLive = $el("sLive");
  sRange.max = Math.max(0, STOPS.length - 1);

  /* Turn the float position into (a) the discrete state the renderer already understands and
     (b) the glide overlay. `now` is pinned to the stop being walked FROM for the whole of the
     transition, which is the point: routes, belief, closures and the block count stay honest
     until the walker actually arrives, and then all advance together. */
  function applyPos() {
    if (!STOPS.length) return;
    const i = Math.min(Math.floor(pos), STOPS.length - 1), f = pos - i;
    const a = STOPS[i], b = STOPS[i + 1], seg = SEGS[i];
    now = a.t;
    if (b && seg && f > 0 && W.nodes[a.node] && W.nodes[b.node]) {
      const e = f < .5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;   // ease in-out
      const [ai, ak] = W.nodes[a.node], [bi, bk] = W.nodes[b.node];
      GLIDE = {
        x: nodeX(ai) + (nodeX(bi) - nodeX(ai)) * e,
        y: nodeY(ak) + (nodeY(bk) - nodeY(ak)) * e,
        deg: (HDEG[a.heading] ?? 0) + seg.dTurn * e,
        head: e >= .5 ? (b.heading || a.heading) : a.heading,
        partial: seg.kind === "move",
        fromNode: a.node, toNode: b.node, leg: 1,
      };
    } else GLIDE = null;
    /* DEMO: in voice mode the discrete state runs on the REAL call clock, so everything that
       happens BETWEEN two corners - a belief update, a directions call, a closure being
       discovered - appears when it actually happened rather than being held back to the next
       step. Only while the walker is mid-block is `now` still pinned to the corner behind
       them, because letting it run on would move the node under a marker that has not got
       there yet. */
    if (VOICEON && VCLK != null && !GLIDE) now = Math.max(now, VCLK);
    stepIdx = i;
    sRange.value = i;
    ACTION = (GLIDE && b) ? (b.text || b.kind) : (a.text || a.kind);
    // No wall-clock in walk mode. With no audio, "50.0 s" is noise, and worse, it makes two
    // stops a fifth of a second apart look like a rendering fault. In voice mode the clock is
    // the whole point, so it goes back in.
    sLabel.textContent = (VOICEON && VCLK != null ? `${mmss(VCLK)} · ` : "")
      + `step ${i + 1} of ${STOPS.length} · ${ACTION}`;
  }

  /* ---- DEMO voice mode -----------------------------------------------------------------
     The silent map is the default and the argument of the page. But in a room somebody always
     asks "so what were they actually saying?", and the honest answer is a recording, not a
     paraphrase. Turning Voice on swaps the index clock for the real call clock: the audio
     element is the master, `now` follows it, and the walker moves when the walker moved.

     The two clocks agree by construction. Trace times are tick index x 0.2 s, transcript
     start/end seconds come off the same ticks, and the wav is that same recording, so nothing
     is aligned by hand and nothing can drift. */
  let VOICE = null, VOICEON = false, VCLK = null, VDUR = 0, AUDIOOK = false, uttEls = [], uttI = -1;
  const audioEl = $el("audio"), railEl = $el("rail"), uttsEl = $el("utts");
  const vTile = $el("sVoice");

  const mmss = (s) => {
    s = Math.max(0, Math.round(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* Last stop at or before t. Linear from the current index rather than a binary search: the
     clock moves forwards a frame at a time, so this is one comparison in the normal case. */
  function idxAt(t) {
    let i = Math.min(Math.floor(pos), STOPS.length - 1);
    if (STOPS[i] && STOPS[i].t > t) i = 0;
    while (i + 1 < STOPS.length && STOPS[i + 1].t <= t) i++;
    return i;
  }
  const vTime = () => (AUDIOOK ? audioEl.currentTime : (VCLK || 0));
  const vEnded = () => (AUDIOOK ? (audioEl.ended || audioEl.currentTime >= VDUR - 0.05)
                                : (VCLK || 0) >= VDUR);

  function paintRail(t) {
    if (!uttEls.length) return;
    let i = uttI;
    if (i < 0 || !uttEls[i] || +uttEls[i].dataset.s > t) i = 0;
    while (i + 1 < uttEls.length && +uttEls[i + 1].dataset.s <= t) i++;
    if (i === uttI) return;
    if (uttEls[uttI]) uttEls[uttI].classList.remove("on");
    uttI = i;
    const e = uttEls[i];
    if (!e) return;
    e.classList.add("on");
    // scrollIntoView on the rail only, never the page: the map must not move under the viewer
    const box = uttsEl.getBoundingClientRect(), r = e.getBoundingClientRect();
    if (r.top < box.top + 8 || r.bottom > box.bottom - 8)
      uttsEl.scrollTop += (r.top - box.top) - box.height * 0.45;
  }

  function buildRail(v) {
    VOICE = v || null;
    uttEls = []; uttI = -1; uttsEl.innerHTML = "";
    vTile.disabled = !(v && (v.utterances || []).length);
    if (!v) return;
    const frag = document.createDocumentFragment();
    for (const u of v.utterances || []) {
      const d = document.createElement("div");
      d.className = "wm-utt " + (u.who === "user" ? "u" : "a");
      d.dataset.s = u.s;
      d.innerHTML = `<span class="wm-utt-t">${mmss(u.s)}</span>`
        + `<span class="wm-utt-w">${u.who === "user" ? "Walker" : "Copilot"}</span>`
        + `<span class="wm-utt-x">${esc(u.text)}</span>`;
      d.onclick = () => seekTime(u.s);       // click a line, the map goes to that moment
      frag.appendChild(d);
      uttEls.push(d);
    }
    uttsEl.appendChild(frag);
    const last = (v.utterances || [])[uttEls.length - 1];
    VDUR = Math.max(last ? last.e : 0, STOPS.length ? STOPS[STOPS.length - 1].t : 0) + 1.5;
    if (v.audio) {
      audioEl.src = v.audio;
      audioEl.hidden = false;
      $el("railNote").textContent = "";
    } else {
      audioEl.removeAttribute("src");
      audioEl.hidden = true;
      $el("railNote").textContent = "transcript only, no audio kept for this call";
    }
  }

  /* ---- speech activity timeline --------------------------------------------------------
     Canvas, not DOM: a busy call carries a few hundred spans, ticks and effect marks, and as
     DOM nodes they cost more to lay out than the map does to draw. It is repainted only when
     the data or the width changes; the playhead is a separate element that moves every frame.

     What it shows, top to bottom: the copilot's speech, the walker's speech, a talk-over band
     where both were speaking at once, contested turn markers, tool calls as ticks above their
     own lane, and the audio effects applied to the channel along the bottom. */
  const tlEl = $el("tl"), tlStage = $el("tlStage"), tlc = $el("tlc"), tlHead = $el("tlHead");
  const TLH = { ruler: 15, lane: 22, gap: 3, fx: 7 };
  const tlHeight = TLH.ruler + TLH.lane * 2 + TLH.gap * 2 + TLH.fx + 4;

  function cssv(n, fb) {
    const v = getComputedStyle(root).getPropertyValue(n).trim();
    return v || fb;
  }
  function overlaps(a, b) {                       // both channels open at once
    const out = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      const s = Math.max(a[i][0], b[j][0]), e = Math.min(a[i][1], b[j][1]);
      if (e > s) out.push([s, e]);
      if (a[i][1] < b[j][1]) i++; else j++;
    }
    return out;
  }

  function drawTL() {
    if (!VOICE || tlEl.hidden) return;
    const w = Math.max(80, tlStage.clientWidth), dpr = Math.min(2, devicePixelRatio || 1);
    tlc.width = Math.round(w * dpr); tlc.height = Math.round(tlHeight * dpr);
    tlc.style.width = w + "px"; tlc.style.height = tlHeight + "px";
    const c = tlc.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, tlHeight);
    const X = (t) => Math.max(0, Math.min(w, (t / (VDUR || 1)) * w));

    const line = cssv("--ui-line", "#2a3242"), dim = cssv("--ui-dim", "#8a93a6");
    const agentC = cssv("--ui-accent", "#5aa9ff"), userC = cssv("--route", "#39d0b4");
    const badC = cssv("--bad", "#ff6b6b");

    // ruler: a minute grid, plus a tick for every step the walker actually took
    c.fillStyle = dim; c.font = "10px ui-monospace,SFMono-Regular,Menlo,monospace";
    c.strokeStyle = line; c.lineWidth = 1;
    const stepMin = VDUR > 900 ? 300 : VDUR > 420 ? 120 : 60;
    for (let t = 0; t <= VDUR; t += stepMin) {
      const x = Math.round(X(t)) + .5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, tlHeight); c.stroke();
      c.fillText(mmss(t), Math.min(w - 26, x + 3), 10);
    }
    c.fillStyle = cssv("--route", "#39d0b4");
    for (const s of STOPS) {
      if (s.kind === "start") continue;
      const x = X(s.t);
      c.fillRect(x, TLH.ruler - 4, 1, 4);
    }

    const yA = TLH.ruler + TLH.gap, yU = yA + TLH.lane + TLH.gap;
    const laneBg = cssv("--ui-card", "#161b24");
    c.fillStyle = laneBg; c.fillRect(0, yA, w, TLH.lane); c.fillRect(0, yU, w, TLH.lane);

    const L = VOICE.lanes || { user: [], agent: [] };
    const paint = (spans, y, col) => {
      c.fillStyle = col;
      for (const [s, e] of spans) {
        const x = X(s), ww = Math.max(1.5, X(e) - x);
        c.fillRect(x, y + 3, ww, TLH.lane - 6);
      }
    };
    paint(L.agent || [], yA, agentC);
    paint(L.user || [], yU, userC);

    // talk-over: drawn ACROSS both lanes so it cannot be mistaken for either side's speech
    const ov = overlaps(L.agent || [], L.user || []);
    c.fillStyle = badC;
    for (const [s, e] of ov) {
      const x = X(s), ww = Math.max(1.5, X(e) - x);
      c.globalAlpha = .85; c.fillRect(x, yA + TLH.lane - 1, ww, TLH.gap + 2); c.globalAlpha = 1;
    }

    // tool calls: a tick above the lane of whoever made the call
    for (const t of (VOICE.tools || [])) {
      const x = X(t.t), y = t.who === "user" ? yU : yA;
      c.fillStyle = t.who === "user" ? userC : agentC;
      c.fillRect(x, y - 2.5, 1.5, 2.5);
    }

    // contested turns: the moments one side took the channel while the other still had it
    c.fillStyle = badC;
    for (const t of (VOICE.turns || [])) {
      if (t.kind !== "contested") continue;
      const x = X(t.t);
      c.beginPath(); c.moveTo(x - 2.6, yA - 3.5); c.lineTo(x + 2.6, yA - 3.5);
      c.lineTo(x, yA - .5); c.closePath(); c.fill();
    }

    // effects applied to the channel: what the call was fighting through
    const yF = yU + TLH.lane + 2;
    const FXC = { frame_drop: "#8a93a6", packet_loss: "#8a93a6", burst_noise: "#e0a341",
                  continuous_noise: "#c98b2e", out_of_turn_speech: "#b98cff",
                  interrupt: "#b98cff" };
    for (const f of (VOICE.effects || [])) {
      const x = X(f.s), ww = Math.max(1, X(f.e) - x);
      c.fillStyle = FXC[f.kind] || dim;
      c.globalAlpha = .8; c.fillRect(x, yF, ww, TLH.fx - 2); c.globalAlpha = 1;
    }
  }

  function tlSeek(ev) {
    const r = tlStage.getBoundingClientRect();
    seekTime(((ev.clientX - r.left) / Math.max(1, r.width)) * VDUR);
  }
  let tlDrag = false;
  tlStage.addEventListener("pointerdown", (e) => {
    if (!VOICEON) return;
    tlDrag = true; tlStage.setPointerCapture(e.pointerId); tlSeek(e);
  });
  tlStage.addEventListener("pointermove", (e) => { if (tlDrag) tlSeek(e); });
  tlStage.addEventListener("pointerup", () => { tlDrag = false; });

  function seekTime(t) {
    t = Math.max(0, Math.min(VDUR, t));
    VCLK = t;
    if (AUDIOOK) { try { audioEl.currentTime = t; } catch (e) { /* not seekable yet */ } }
    pos = idxAt(t);
    phase = "run"; svg.style.opacity = "1";
    applyPos(); drawStateNow(); paintRail(t);
    tlHead.style.left = ((t / (VDUR || 1)) * 100).toFixed(3) + "%";
    $el("cTime").textContent = `${mmss(t)} / ${mmss(VDUR)}`;
  }

  /* Voice mode is a MODE, not a layer on top of the walk. Turning it on swaps the whole
     transport: the looping index clock is put away, the step buttons and the Loop toggle go
     with it, the recording becomes the master clock, and the speech activity timeline appears
     under the map. The call plays once and stops at the end, because a call that silently
     restarts mid-sentence is disorienting in a way a looping silent map is not. */
  function voiceOn(on) {
    if (on && !VOICE) return;
    VOICEON = !!on;
    root.classList.toggle("wm-voice", VOICEON);
    vTile.classList.toggle("on", VOICEON);
    railEl.hidden = !VOICEON;
    tlEl.hidden = !VOICEON;
    $el("callbar").hidden = !VOICEON;
    // The walk transport steps aside. Driven by the mode class, not by the hidden attribute:
    // .wm-steps sets display:flex, which beats the browser's own [hidden] rule.
    if (VOICEON) {
      const L = VOICE.lanes || { user: [], agent: [] };
      const ov = overlaps(L.agent || [], L.user || []);
      const talkOver = ov.reduce((a, [s, e]) => a + (e - s), 0);
      const contested = (VOICE.turns || []).filter(t => t.kind === "contested").length;
      $el("cStats").textContent =
        `${(VOICE.utterances || []).length} utterances · ${(VOICE.tools || []).length} tool calls`
        + ` · talk-over ${mmss(talkOver)} · ${contested} contested turns`
        + ` · ${(VOICE.effects || []).length} audio effects`;
      $el("railTitle").textContent = `Call transcript · ${mmss(VDUR)}`;
      VCLK = 0; pos = 0; uttI = -1; phase = "run"; svg.style.opacity = "1";
      applyPos(); drawStateNow(); paintRail(0);
      requestAnimationFrame(drawTL);
      if (VOICE.audio) {
        audioEl.currentTime = 0;
        audioEl.play().then(() => { AUDIOOK = true; })
          .catch(() => {                   // autoplay refused, or the file will not decode
            AUDIOOK = false;
            $el("railNote").textContent = "audio blocked by the browser, press play above";
          });
      }
      start();
    } else {
      VCLK = null; AUDIOOK = false;
      try { audioEl.pause(); } catch (e) { /* nothing playing */ }
      pos = 0; phase = "run"; svg.style.opacity = "1";
      applyPos(); drawStateNow();
      start();
    }
    // The rail and the timeline take room from the map, so the framing has to be recomputed,
    // not merely rescaled. ResizeObserver fires for that; this covers the case where it does not.
    requestAnimationFrame(() => { if (!USERCAM && !follow) fitJourney(); });
  }

  /* The call transport. Deliberately not the same controls as the walk: there are no steps in
     a recording, there is a clock. */
  $el("cPlay").onclick = () => {
    if (running) { stop(); if (AUDIOOK) { try { audioEl.pause(); } catch (e) { } } }
    else {
      if (vEnded()) seekTime(0);
      if (AUDIOOK) { try { audioEl.play(); } catch (e) { } }
      phase = "run"; svg.style.opacity = "1"; start();
    }
  };
  $el("cBack").onclick = () => seekTime(vTime() - 10);
  $el("cFwd").onclick  = () => seekTime(vTime() + 10);
  $el("cRestart").onclick = () => {
    seekTime(0);
    if (AUDIOOK) { try { audioEl.play(); } catch (e) { } }
    phase = "run"; svg.style.opacity = "1"; start();
  };
  $el("cExit").onclick = () => voiceOn(false);

  // The native controls are the presenter's, so what they do has to win: scrubbing the audio
  // moves the map, pausing the audio pauses the walk.
  audioEl.addEventListener("playing", () => { AUDIOOK = true; if (VOICEON) start(); });
  audioEl.addEventListener("pause", () => { if (VOICEON && !audioEl.ended) stop(); });
  audioEl.addEventListener("seeking", () => { if (VOICEON) { VCLK = audioEl.currentTime;
    pos = idxAt(VCLK); uttI = -1; } });

  vTile.onclick = () => voiceOn(!VOICEON);
  buildRail(voice);

  /* The loop is a small phase machine: run, hold at the destination, fade out, cut back to
     the start, fade in, small hold, run again. The fade is what makes the reset read as a
     deliberate restart rather than a glitch, and it also hides the one frame where the label
     solver re-runs at the new camera position. */
  const HOLD = { head: 500, tail: 1600, fade: 220 };
  let running = true, loopOn = true, phase = "head", phaseT = 0, rafId = 0, lastTs = 0;
  let resumeTimer = 0;

  function camCutToStart() {
    if (!follow) return;                       // panned away by hand: leave the view alone
    const n = STOPS[0] && STOPS[0].node;
    if (!n || !W.nodes[n]) return;
    if (anim) { cancelAnimationFrame(anim); anim = null; }   // kill any camera ease in flight
    const [i, k] = W.nodes[n];
    CX = nodeX(i); CY = nodeY(k);
    TGT = { v: VIEW, x: CX, y: CY };           // leash compares against TGT, so no ease fires
    writeView(); drawBuildings(); drawLabels();
  }

  function frame(ts) {
    if (!running) { rafId = 0; return; }
    if (!lastTs) lastTs = ts;
    const dt = Math.min(64, ts - lastTs);      // a backgrounded tab must not teleport
    lastTs = ts;
    if (phase === "run" && VOICEON) {
      /* Voice mode. The call is the master clock and the walker chases it: the target index is
         whatever stop the recording has reached, and `pos` eases towards it at the same speed a
         step takes in walk mode. The real gaps are tens of seconds, so the glide always lands
         long before the next step is due, and the walker then simply stands there - which is
         what actually happened while the two of them talked. */
      if (!AUDIOOK) VCLK = (VCLK || 0) + dt / 1000;      // no audio: run the clock ourselves
      else VCLK = audioEl.currentTime;
      const tgt = idxAt(VCLK);
      if (pos < tgt) {
        const i = Math.floor(pos);
        pos = Math.min(tgt, pos + dt / ((SEGS[i] || {}).ms || DUR.move));
      } else if (pos > tgt) {
        pos = tgt;                                        // the audio was scrubbed backwards
      }
      paintRail(VCLK);
      paintCall(VCLK);
      /* No loop here, on purpose. The silent map loops because it is a diagram; a recorded
         call that jumped back to the top mid-sentence would read as a fault. It ends, and
         Restart call is right there. */
      if (vEnded()) { stop(); applyPos(); drawStateNow(); return; }
    } else if (phase === "run") {
      const i = Math.floor(pos);
      if (i >= SEGS.length) {
        if (!loopOn) { stop(); applyPos(); drawStateNow(); return; }
        phase = "tail"; phaseT = 0;
      } else {
        // Clamp to the segment boundary so each step gets its whole duration and the
        // remainder never leaks into the next one at a different rate.
        pos = Math.min(i + 1, pos + dt / SEGS[i].ms);
      }
    } else {
      phaseT += dt;
      if (phase === "out") svg.style.opacity = String(Math.max(0, 1 - phaseT / HOLD.fade));
      if (phase === "in")  svg.style.opacity = String(Math.min(1, phaseT / HOLD.fade));
      const lim = phase === "tail" ? HOLD.tail : phase === "head" ? HOLD.head : HOLD.fade;
      if (phaseT >= lim) {
        if (phase === "out") {                 // rewind happens at opacity zero
          pos = 0; REWINDING = true;
          if (VOICEON) {                       // the call restarts with the walk, from zero
            VCLK = 0; uttI = -1;
            if (AUDIOOK) { try { audioEl.currentTime = 0; audioEl.play(); } catch (e) { } }
          }
          applyPos(); camCutToStart(); REWINDING = false;
        }
        phase = { tail: "out", out: "in", in: "head", head: "run" }[phase];
        phaseT = 0;
        if (phase === "run") svg.style.opacity = "1";
      }
    }
    applyPos();
    drawStateNow();
    rafId = requestAnimationFrame(frame);
  }

  /* The playhead and the clock, moved every frame. Everything else on the timeline is painted
     into the canvas once, so this is one style write per frame rather than a repaint. */
  function paintCall(t) {
    tlHead.style.left = ((t / (VDUR || 1)) * 100).toFixed(3) + "%";
    $el("cTime").textContent = `${mmss(t)} / ${mmss(VDUR)}`;
  }

  function label() {
    $el("sPlay").textContent = running ? "Pause" : "Play";
    $el("cPlay").textContent = running ? "Pause" : (VOICEON && vEnded() ? "Replay" : "Play");
  }
  function start() {
    if (running) return;
    running = true; lastTs = 0; label();
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0; label();
  }
  function clearResume() { if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = 0; }

  /* Scrubbing pauses, then resumes on its own after a quiet spell. A permanent freeze is the
     wrong default for a page that mostly runs unattended on a screen: someone pokes the
     scrubber to make a point, walks away, and it never moves again. Six seconds is long
     enough not to fight a deliberate scrub. */
  function armResume() {
    clearResume();
    resumeTimer = setTimeout(() => {
      resumeTimer = 0; phase = "run"; svg.style.opacity = "1";
      if (VOICEON && AUDIOOK) { try { audioEl.play(); } catch (e) { } }
      start();
    }, 6000);
  }
  function jump(i) {
    stop();
    pos = Math.max(0, Math.min(SEGS.length, i));
    phase = "run"; svg.style.opacity = "1";
    // In voice mode a step is a seek in the recording, not just a move on the map, otherwise
    // the transcript and the walker would be describing two different moments.
    if (VOICEON && STOPS[Math.floor(pos)]) seekTime(STOPS[Math.floor(pos)].t);
    else { applyPos(); drawStateNow(); }
    armResume();
  }

  $el("sPlay").onclick = () => {
    if (running) {
      stop(); clearResume();
      if (VOICEON && AUDIOOK) { try { audioEl.pause(); } catch (e) { } }
    } else {
      clearResume();
      if (VOICEON) { if (vEnded()) seekTime(0);
                     if (AUDIOOK) { try { audioEl.play(); } catch (e) { } } }
      else if (pos >= SEGS.length) pos = 0;
      phase = "run"; svg.style.opacity = "1"; start();
    }
  };
  $el("sPrev").onclick = () => jump(Math.floor(pos) - 1);
  $el("sNext").onclick = () => jump(Math.floor(pos) + 1);
  sRange.oninput = () => jump(+sRange.value);
  sLive.onclick = () => { loopOn = !loopOn; sLive.classList.toggle("on", loopOn); };

  // rAF does not run in a hidden tab, so the first frame back would carry a huge dt.
  const onVis = () => { lastTs = 0; };
  document.addEventListener("visibilitychange", onVis);

  /* The shipped renderer opened on `now = 1e9`, the finished walk with the full trail drawn
     and the walker standing on the destination. On a looping demo that is a spoiler on every
     single load, so the page opens where the walk opens: at stop zero. */
  /* DEMO: ?step=N freezes the page at a fixed point in the walk, fractions allowed, so a
     screenshot is reproducible. ?step=2.5 is the middle of the third transition. Used for
     checking the glide and the part-drawn trail; harmless if nobody passes it. */
  const _q = new URLSearchParams(location.search);
  if (_q.has("step")) {
    pos = Math.max(0, Math.min(SEGS.length, parseFloat(_q.get("step")) || 0));
    running = false;
  }
  applyPos();
  label();
  if (running) rafId = requestAnimationFrame(frame);
  else requestAnimationFrame(() => drawStateNow());

  /* DEMO: a read-only probe. The whole renderer lives in a closure, so without this there is
     no way to check from outside that the walk is actually advancing and looping rather than
     sitting on a still frame that happens to look right. */
  /* DEMO: compact is the gallery tile: the same live walk, no controls, no read-out, no
     legend. Everything is done with a class rather than by skipping the markup, so a tile and
     the full page are the same instance with the same behaviour, and clicking through cannot
     show something the tile was not showing. */
  if (compact) root.classList.add("wm-compact");

  const probe = {
    get pos()     { return pos; },
    get phase()   { return phase; },
    get running() { return running; },
    get loopOn()  { return loopOn; },
    get stops()   { return STOPS.length; },
    get segs()    { return SEGS.length; },
    get action()  { return ACTION; },
    get follow()  { return follow; },
    get view()    { return Math.round(VIEW); },
    get tier()    { return tierName(); },
    get glide()   { return GLIDE && { x: Math.round(GLIDE.x), y: Math.round(GLIDE.y),
                                      deg: Math.round(GLIDE.deg), partial: GLIDE.partial }; },
    get voiceOn() { return VOICEON; },
    get voiceReady() { return !!(VOICE && (VOICE.utterances || []).length); },
    get audioOk() { return AUDIOOK; },
    get clock()   { return VCLK == null ? null : Math.round(VCLK * 10) / 10; },
    get utts()    { return uttEls.length; },
    get uttI()    { return uttI; },
    get key()     { return (GEO.meta || {}).key || ""; },
  };
  // Six tiles on the gallery would fight over one global, so only the full-page instance
  // claims it. The tiles hand their probe back through the returned handle instead.
  if (!compact) window.__dw = probe;

  // one-line summary under the map, kept from v1 so the numbers stay where people look
  if (divHost) {
    const pct = (v) => v == null ? "-" : Math.round(v * 100) + "%";
    divHost.innerHTML =
      `<b style="color:${R.arrived ? "var(--good)" : "var(--bad)"}">`
      + `${R.arrived ? "Delivered" : "Not delivered"}</b>`
      + ` &nbsp;·&nbsp; blocks <b>${R.blocks_walked}</b> of ${R.optimal_blocks_clear}`
      + (R.route_efficiency != null ? ` (efficiency <b>${R.route_efficiency.toFixed(2)}</b>)` : "")
      + ` &nbsp;·&nbsp; wrong-way <b>${R.wrong_way_moves}</b>`
      + ` &nbsp;·&nbsp; believes corner <b>${pct(R.belief_node_accuracy)}</b>,`
      + ` facing <b>${pct(R.belief_heading_accuracy)}</b>`
      + (R.closures_total ? ` &nbsp;·&nbsp; closures <b>${R.closures_discovered}/${R.closures_total}</b>` : "")
      + (R.track_side ? ` &nbsp;·&nbsp; pavement <b>${R.on_right_side ? "correct" : "WRONG SIDE"}</b>` : "");
  }

  /* DEMO: a teardown handle. Switching between the two walks rebuilds this whole closure
     against a fresh payload, and without this the old instance keeps its rAF loop, its
     resize observer and its camera ease alive, drawing into a detached SVG forever. */
  return {
    /* DEMO: the voice payload arrives late. The map is ~70 KB and the call is a few megabytes,
       so the page loads every map up front and fetches a recording only when somebody actually
       asks to hear one. This hands that recording to an instance already on screen. */
    setVoice(v) {
      buildRail(v);
      if (VOICEON) voiceOn(true);          // already open: restart on the new call
    },
    get hasVoice() { return !!(VOICE && (VOICE.utterances || []).length); },
    setVoiceMode(on) { voiceOn(on); },
    probe,
    destroy() {
      stop();
      clearResume();
      document.removeEventListener("visibilitychange", onVis);
      if (anim) { cancelAnimationFrame(anim); anim = null; }
      if (_stateQueued) { cancelAnimationFrame(_stateQueued); _stateQueued = 0; }
      if (roT) { clearTimeout(roT); roT = 0; }
      try { ro.disconnect(); } catch (e) { /* observer already gone */ }
      // Stop the audio and drop the source, or the call keeps playing over the next case.
      try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch (e) { }
      host.innerHTML = "";
    },
  };
};
