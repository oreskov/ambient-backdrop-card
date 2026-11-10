/*!
 * Ambient Backdrop Card til Home Assistant  (v1.2.0)
 * https://github.com/oreskov/ambient-backdrop-card  -  MIT-licens
 *
 * Et kort, der lægger en animeret canvas-baggrund bag hele dashboardet.
 * Uden for redigering er kortet usynligt.
 * - 16 stilarter (i editorens rækkefølge): partikler, netværk, strømning, matrix, retro-gitter,
 *   hexagon-net, aurora, nordlys-gardiner, stjernehimmel, ildfluer, støv i lys, bokeh,
 *   lavalampe, gradient, bølger og regnvindue.
 * - Farver og vejr-overlay følger en weather.*-entitet og sun.sun (dag/nat).
 * - Valgfri baggrund bag animationen: tema, billede eller mp4-video i loop.
 * - Visuel editor på dansk og engelsk (efter HA's sprog).
 *
 * Filen er opdelt i sektioner:
 *   1. Hjælpefunktioner
 *   2. Standardindstillinger (DEFAULTS): alle indstillinger og deres standardværdier
 *   3. Farvepaletter pr. vejrtype
 *   4. Engine (tegner og styrer animationen)
 *   5. STYLES (de 16 baggrunde, hver er en selvstændig funktion)
 *   6. Bg (monterer canvas bag dashboardet)
 *   7. Kortet (AmbientBackdropCard)
 *   8. Tekster (STRINGS: dansk og engelsk)
 *   9. Editoren (AmbientBackdropCardEditor)
 */
(() => {
  'use strict';

  const VERSION = '1.2.0';

  /* ======================================================================
   * 1. HJÆLPEFUNKTIONER
   * ==================================================================== */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  // Farver gemmes som [r,g,b]. rgba() laver dem om til en CSS-streng.
  const rgba = (c, a) =>
    `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  // Accepterer [r,g,b], "#rrggbb" eller "r,g,b"
  function parseColor(v, fallback) {
    if (Array.isArray(v) && v.length >= 3) return v.slice(0, 3).map(Number);
    if (typeof v === 'string') {
      const m = v.trim().match(/^#?([0-9a-f]{6})$/i);
      if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      const p = v.split(',').map((s) => Number(s.trim()));
      if (p.length >= 3 && p.every(Number.isFinite)) return p.slice(0, 3);
    }
    return fallback;
  }

  // Gør en sti/URL sikker at bruge inde i CSS url("...")
  const cssUrl = (u) => String(u).replace(/["\\\n]/g, (m) => encodeURIComponent(m));

  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // Farvetone (0-360), mætning og lysstyrke (0-100) -> [r,g,b]
  function hslRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  // Lille tegneflade til bløde stilarter. Der tegnes i lav opløsning, og resultatet skaleres op.
  // Det er hurtigere, og det giver en blødere, mere naturlig glød.
  function lowRes(e, div) {
    const bw = clamp(Math.round(e.w / (e.mobile ? div * 1.5 : div)), 120, 480);
    const bh = Math.max(60, Math.round((bw * e.h) / e.w));
    const c = document.createElement('canvas');
    c.width = bw;
    c.height = bh;
    return { c, g: c.getContext('2d'), bw, bh };
  }

  // En 1 pixel bred farveprøve, som strimlerne i aurora/nordlys tegnes med
  function makeSprite() {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 256;
    return c;
  }

  // Regnvindue: en ny dråbe på ruden. grown = true giver en lidt større startstørrelse
  function rwDrop(e, grown) {
    const sz = e.cfg.rainwindow_size;
    if (e.cfg.rainwindow_natural) {
      // Naturlig fordeling: mange små og få store dråber. Hver dråbe har sin egen glans, glidefart og tærskel.
      return {
        x: rnd(0, e.w),
        y: rnd(0, e.h),
        r: (grown ? 0.8 + 5.2 * Math.pow(Math.random(), 2.4) : rnd(0.6, 1.5)) * sz,
        thr: rnd(5, 13) * sz,
        gl: rnd(0.55, 1.4), // glans (størrelse på lysglimtet)
        vm: rnd(0.6, 1.5), // glidefart i forhold til andre
      };
    }
    return {
      x: rnd(0, e.w),
      y: rnd(0, e.h),
      r: (grown ? rnd(1.5, 5.5) : rnd(0.8, 1.6)) * sz,
      thr: rnd(6, 10) * sz, // ved denne størrelse begynder dråben at glide
      gl: 1,
      vm: 1,
    };
  }

  // Matrix: tegnsæt, skrifttyper og hjælpefunktioner
  // Tegnene er bygget af tegnkoder (ikke indsat som tekst), så de virker, uanset hvordan filen læses
  const cp = (...codes) => codes.map((c) => String.fromCodePoint(c)).join('');
  const cpRange = (a, b) => {
    let o = '';
    for (let c = a; c <= b; c++) o += String.fromCodePoint(c);
    return o;
  };
  const MATRIX_SETS = {
    katakana: cpRange(0xff71, 0xff9d) + '0123456789', // halvbredde katakana
    // Ældre futhark (24 runer)
    runes: cp(0x16a0, 0x16a2, 0x16a6, 0x16a8, 0x16b1, 0x16b2, 0x16b7, 0x16b9, 0x16ba, 0x16be, 0x16c1, 0x16c3, 0x16c7, 0x16c8, 0x16c9, 0x16ca, 0x16cf, 0x16d2, 0x16d6, 0x16d7, 0x16da, 0x16dc, 0x16de, 0x16df),
    binary: '01',
    hex: '0123456789ABCDEF',
    ascii: '<>/\\{}[]()=+*-_;:#$%&?!|~^@',
  };
  MATRIX_SETS.mix = MATRIX_SETS.katakana + MATRIX_SETS.runes;
  // Fallback-rækkefølge: skrifttyper med japansk og runer, derefter systemets monospace
  const MATRIX_FONT =
    '"Noto Sans Mono CJK JP","MS Gothic","Hiragino Kaku Gothic ProN","Segoe UI Historic","Noto Sans Runic","Apple Symbols",monospace';

  function matrixChars(cfg) {
    const s = cfg.matrix_charset === 'custom' ? String(cfg.matrix_custom || '').replace(/\s/g, '') : MATRIX_SETS[cfg.matrix_charset];
    const a = Array.from(s || MATRIX_SETS.katakana);
    return a.length ? a : Array.from(MATRIX_SETS.katakana);
  }

  // En kolonne af faldende tegn. Alle starter oven for skærmen med forskudt ventetid.
  // En kolonne af faldende tegn. v (matrix_variation) styrer, hvor meget fart, halelængde og styrke varierer:
  // 0 = alle ens, 1 = som standard, op til 1,5 = meget forskellige. first = true ved opstart.
  function matrixCol(rows, sp, cfg, first) {
    const v = clamp(cfg.matrix_variation, 0, 1.5);
    const speed = 13.5 * sp * (1 + 0.48 * v * rnd(-1, 1)); // felter pr. sekund
    const dens = clamp(cfg.density, 0.2, 2);
    return {
      head: -rnd(0, 4), // starter altid oven for skærmen
      speed,
      len: 16 * cfg.matrix_trail * (1 + 0.5 * v * rnd(-1, 1)), // halens længde i felter
      b: 1 - 0.35 * v * Math.random(), // nogle kolonner er svagere end andre
      // Ved opstart spredes ventetiden over en del af faldtiden, så de langsomme kolonner ikke falder som én bølge
      wait: first ? rnd(0, (rows / speed) * 0.6 + 2) / dens : rnd(0, 5 / dens),
      last: -1,
    };
  }

  // Tegnbilledet i den aktuelle farve. Farves kun om, når farven har ændret sig mærkbart
  // (paletten glider langsomt), så det næsten ikke koster noget.
  function matrixTint(s, rgb, soft) {
    // soft = true: den slørede udgave af tegnene (bruges til tegnets glød)
    const k = soft ? 'tintB' : 'tint';
    const kr = soft ? 'tintBRgb' : 'tintRgb';
    const src = soft ? s.atlasBlur : s.atlas;
    const last = s[kr];
    if (!s[k] || Math.abs(rgb[0] - last[0]) > 3 || Math.abs(rgb[1] - last[1]) > 3 || Math.abs(rgb[2] - last[2]) > 3) {
      if (!s[k]) {
        s[k] = document.createElement('canvas');
        s[k].width = src.width;
        s[k].height = src.height;
      }
      const g = s[k].getContext('2d');
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, src.width, src.height);
      g.drawImage(src, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = rgba(rgb, 1);
      g.fillRect(0, 0, src.width, src.height);
      s[kr] = [rgb[0], rgb[1], rgb[2]];
    }
    return s[k];
  }

  // Lysende glød omkring en kolonnes hoved. Tegnes én gang pr. farve (afrundet) og bruges igen,
  // i stedet for at lave en ny gradient for hvert hoved i hver frame.
  function matrixGlow(cache, rgb) {
    const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3);
    let c = cache.get(key);
    if (!c) {
      if (cache.size > 80) cache.clear();
      c = document.createElement('canvas');
      c.width = c.height = 48;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(24, 24, 0, 24, 24, 24);
      gr.addColorStop(0, rgba(rgb, 0.3));
      gr.addColorStop(1, rgba(rgb, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, 48, 48);
      cache.set(key, c);
    }
    return c;
  }

  // Blød aftoning: følger en klokkeformet kurve i stedet for en lige linje,
  // så klatten ikke får en synlig kant
  function softRadial(ctx, x, y, r, col, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const end = Math.exp(-4);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const k = (Math.exp(-4 * t * t) - end) / (1 - end);
      g.addColorStop(t, rgba(col, a * k));
    }
    return g;
  }

  // Næsten usynlig støj, der blander farvetrinene. Hver prik er enten hvid (lysner)
  // eller sort (mørkner) med tilfældig gennemsigtighed 0..amp ud af 255.
  // Brikken er 256x256, så gentagelsen ikke kan ses. Én brik gemmes pr. styrke.
  const NOISE = {};
  function noisePattern(ctx, amp) {
    if (!NOISE[amp]) {
      const S = 256;
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      const img = g.createImageData(S, S);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() < 0.5 ? 255 : 0;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = (Math.random() * (amp + 1)) | 0;
      }
      g.putImageData(img, 0, 0);
      NOISE[amp] = c;
    }
    return ctx.createPattern(NOISE[amp], 'repeat');
  }

  /* ======================================================================
   * 2. STANDARDINDSTILLINGER
   *    Alt her kan sættes i kortets YAML. En ny indstilling tilføjes her, bruges
   *    som cfg.navn i koden og gøres synlig i editoren (sektion 9, tekster i sektion 8).
   * ==================================================================== */
  const DEFAULTS = {
    // Generelt
    style: 'particles', // particles | network | flow | matrix | retro | hex | aurora | curtains | starfield | fireflies | dust | bokeh | lava | gradient | waves | rainwindow
    animation_enabled: true, // slå fra for kun at vise baggrund/video (og evt. vejr-overlay)
    weather_entity: '',
    sun_entity: 'sun.sun',
    opacity: 0.85, // gennemsigtighed på selve animationen
    speed: 1, // hastighedsmultiplikator
    density: 1, // antal-multiplikator
    interaction: true, // mus/touch påvirker animationen
    max_fps: 40,
    fill_background: true, // tegn en farvet baggrund bag animationen
    dither: true, // støj mod farvetrin/striber på store skærme
    dither_strength: 1, // 0 = fra, 1 = standard, op til 2

    // Baggrund bag animationen (når den ikke er "none", droppes den farvede baggrund)
    background_source: 'none', // none | theme | image | video
    background_image: '', // sti eller URL, fx /local/backgrounds/min.jpg
    background_video: '', // sti eller URL til mp4, fx /local/backgrounds/loop.mp4
    background_video_speed: 1, // afspilningshastighed (0.25-2)
    background_dim: 0.25, // mørkere lag oven på billede/video (0-0.9)
    background_blur: 0, // sløring i pixels (0-20)

    // Farver
    color_mode: 'auto', // auto (vejr + dag/nat) | manual
    color_primary: [79, 163, 255],
    color_secondary: [170, 90, 255],

    // Vejr-overlay
    weather_overlay: true,
    rain: true,
    snow: true,
    fog: true,
    stars: true,
    weather_override: 'auto', // auto | clear | partly | cloudy | rain | pour | snow | fog | storm

    // Partikler
    particles_line_distance: 140,
    particles_line_opacity: 0.35,
    particles_size: 1,

    // Netværk
    network_size: 1,
    network_distance: 1,
    network_rate: 0.4, // hvor ofte signaler sendes (0 = ingen)
    network_speed: 0.5,
    network_glow: true,
    network_shape: 'angled', // angled = rette vinkler | diagonal = 45°-knæk | curved = kurver | straight = lige | mixed
    network_labels: true, // små tekster (adresser)
    network_scan: true, // scanningsringe
    network_color: 'terminal', // terminal | cyber | amber | red | ice | palette

    // Strømning
    flow_trail: 40, // sporlængde (antal punkter)
    flow_speed: 1,
    flow_scale: 1, // strømningernes størrelse: større tal = større sving
    flow_width: 1,
    flow_glow: true, // lysende hoveder
    flow_color_dir: true, // farve efter retning
    flow_weather: true, // regn og storm gør sporene hurtigere og mere skrå

    // Matrix
    matrix_charset: 'katakana', // katakana | runes | mix | binary | hex | ascii | custom
    matrix_custom: '',
    matrix_font: '',
    matrix_size: 18,
    matrix_trail: 1.2,
    matrix_color: 'green', // green | palette | rainbow
    matrix_head: true,
    matrix_smooth: false, // glidende hoved: hovedet toner mellem rækker i stedet for at springe (false = trinvist som i filmen)
    matrix_glow_style: 'round', // glyph = tegnet selv lyser (sløret kopi) | round = rund lysplet
    matrix_glow: 0.2, // glødens styrke omkring hovedet (0 = ingen glød, 1 = kraftig, 2 = meget kraftig)
    matrix_depth: true,
    matrix_mirror: false,
    matrix_variation: 1, // variation i fart, hale og styrke: 0 = alle ens, 1 = standard, 1.5 = meget forskellige
    matrix_mutate: 1,

    // Retro-gitter
    retro_speed: 1,
    retro_horizon: 0.55, // horisontens højde som andel af kortets højde
    retro_lines: 14,
    retro_sun: true,
    retro_skyline: 'mountains', // mountains | city | none
    retro_sea: false, // hav i stedet for gitter
    retro_sky: false, // farvet himmel (dækker baggrunden)
    retro_glow: 1,
    retro_color: 'palette', // palette | classic | miami

    // Hexagon-net
    hex_size: 44,
    hex_grid: true,
    hex_fill: true,
    hex_waves: true,
    hex_ripples: true,

    // Aurora
    aurora_bands: 4,
    aurora_height: 1,
    aurora_intensity: 1,

    // Nordlys-gardiner
    curtains_layers: 3,
    curtains_height: 1,
    curtains_rays: 24,

    // Stjernehimmel
    starfield_size: 1,
    starfield_twinkle: true,
    starfield_parallax: true,
    starfield_shooting: true,

    // Ildfluer
    fireflies_size: 1,
    fireflies_glow: 1,
    fireflies_blink: 0.8,
    fireflies_color: 'warm', // warm | amber | palette

    // Støv i lysstråler
    dust_beams: 4,
    dust_angle: 25,
    dust_origin: 0.15,
    dust_strength: 1,
    dust_motes: true,
    dust_wind: 1, // vind og hvirvler i støvet (0 = støvet driver bare roligt)

    // Bokeh
    bokeh_size: 1,
    bokeh_soft: 0.5,

    // Lavalampe
    lava_blobs: 6,
    lava_size: 1,
    lava_soft: 0.35,
    lava_glow: true,

    // Flydende gradient
    gradient_blobs: 5,
    gradient_size: 1,

    // Bølger
    waves_layers: 5,
    waves_height: 1,
    waves_glow: true,
    waves_foam: true,

    // Regnvindue
    rainwindow_size: 1,
    rainwindow_rate: 1,
    rainwindow_trails: true,
    rainwindow_lights: true,
    rainwindow_natural: true, // naturlig variation: dråber i mange størrelser, dråbeformer og små dråber efter de store

    // Avanceret
    respect_reduced_motion: true,
    always_show_preview: false, // vis kortet også uden for redigeringstilstand
  };

  /* ======================================================================
   * 3. FARVEPALETTER
   *    Rækkefølge: [baggrund-top, baggrund-bund, primær, sekundær, accent]
   * ==================================================================== */
  const PALETTES = {
    clear: {
      day: [[20, 60, 130], [60, 130, 200], [255, 220, 130], [140, 200, 255], [255, 255, 255]],
      night: [[4, 8, 26], [16, 26, 64], [110, 150, 255], [160, 100, 255], [120, 225, 255]],
    },
    partly: {
      day: [[28, 62, 110], [78, 118, 160], [255, 225, 160], [150, 190, 230], [255, 255, 255]],
      night: [[6, 10, 28], [22, 30, 56], [120, 150, 230], [150, 120, 230], [140, 200, 240]],
    },
    cloudy: {
      day: [[40, 54, 74], [92, 106, 124], [200, 212, 228], [150, 165, 190], [235, 240, 248]],
      night: [[10, 13, 22], [30, 36, 50], [120, 135, 165], [100, 110, 140], [160, 175, 200]],
    },
    rain: {
      day: [[22, 34, 52], [50, 70, 96], [120, 170, 220], [80, 120, 170], [180, 210, 240]],
      night: [[6, 10, 18], [18, 28, 44], [70, 120, 180], [60, 90, 140], [110, 160, 210]],
    },
    storm: {
      day: [[24, 24, 44], [54, 50, 80], [170, 150, 230], [110, 110, 190], [230, 230, 255]],
      night: [[6, 6, 16], [22, 18, 40], [130, 110, 210], [90, 80, 170], [200, 190, 255]],
    },
    snow: {
      day: [[60, 80, 110], [150, 170, 195], [235, 245, 255], [180, 210, 240], [255, 255, 255]],
      night: [[14, 20, 36], [44, 58, 86], [190, 215, 245], [140, 170, 220], [235, 245, 255]],
    },
    fog: {
      day: [[70, 80, 92], [140, 150, 160], [225, 230, 235], [185, 195, 205], [245, 248, 250]],
      night: [[16, 20, 26], [44, 50, 58], [150, 160, 172], [110, 120, 132], [190, 198, 208]],
    },
  };

  const CATS = ['clear', 'partly', 'cloudy', 'rain', 'pour', 'snow', 'fog', 'storm'];

  // Oversætter HA's weather-states til vores egne kategorier
  function mapWeather(state) {
    if (!state) return 'clear';
    if (CATS.includes(state)) return state;
    switch (state) {
      case 'sunny':
      case 'clear-night':
      case 'windy':
      case 'windy-variant':
        return 'clear';
      case 'partlycloudy':
        return 'partly';
      case 'cloudy':
      case 'exceptional':
        return 'cloudy';
      case 'rainy':
        return 'rain';
      case 'pouring':
      case 'hail':
        return 'pour';
      case 'lightning':
      case 'lightning-rainy':
        return 'storm';
      case 'snowy':
      case 'snowy-rainy':
        return 'snow';
      case 'fog':
        return 'fog';
      default:
        return 'clear';
    }
  }

  /* ======================================================================
   * 4. ENGINE
   *    Én Engine = ét canvas. Den bruges både til selve baggrunden og til
   *    den lille forhåndsvisning i editoren.
   * ==================================================================== */
  let FOG_SPRITE = null;
  function fogSprite() {
    if (FOG_SPRITE) return FOG_SPRITE;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 256, 256);
    FOG_SPRITE = c;
    return c;
  }

  // Snefnug: tre forrendrede billeder (blød plet, skarp prik, seksarmet krystal), tegnes med drawImage
  let SNOW_SPRITES = null;
  function snowSprites() {
    if (SNOW_SPRITES) return SNOW_SPRITES;
    const mk = (n, fn) => {
      const c = document.createElement('canvas');
      c.width = c.height = n;
      fn(c.getContext('2d'), n);
      return c;
    };
    const soft = mk(64, (g, n) => {
      const gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      gr.addColorStop(0, 'rgba(255,255,255,0.95)');
      gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, n, n);
    });
    const crisp = mk(16, (g, n) => {
      const gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.6, 'rgba(255,255,255,0.9)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, n, n);
    });
    const crystal = mk(96, (g, n) => {
      g.translate(n / 2, n / 2);
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        g.save();
        g.rotate((i * Math.PI) / 3);
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -38);
        g.stroke();
        g.lineWidth = 2.2; // to par grene på hver arm
        for (const [y, l] of [[-16, 11], [-28, 7]]) {
          g.beginPath();
          g.moveTo(0, y);
          g.lineTo(-l * 0.8, y - l * 0.7);
          g.moveTo(0, y);
          g.lineTo(l * 0.8, y - l * 0.7);
          g.stroke();
        }
        g.restore();
      }
    });
    SNOW_SPRITES = { soft, crisp, crystal };
    return SNOW_SPRITES;
  }

  // Et lyn: forgrenet stiplet linje fra toppen. Returnerer liste af [x1,y1,x2,y2,dybde] (dybde 0 = hovedlyn)
  function makeBolt(w, h) {
    const segs = [];
    const step = Math.max(14, h * 0.035);
    const grow = (x, y, base, len, depth) => {
      const n = Math.max(2, Math.round(len / step));
      for (let i = 0; i < n; i++) {
        const a = base + rnd(-0.5, 0.5);
        const nx = x + Math.sin(a) * step;
        const ny = y + Math.cos(a) * step;
        segs.push([x, y, nx, ny, depth]);
        if (depth < 2 && i > 1 && Math.random() < 0.13) grow(nx, ny, base + rnd(-1, 1), len * rnd(0.25, 0.45), depth + 1);
        x = nx;
        y = ny;
      }
    };
    grow(rnd(0.15, 0.85) * w, -10, rnd(-0.25, 0.25), h * rnd(0.6, 0.95), 0);
    return segs;
  }

  class Engine {
    constructor(canvas, getSize) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.getSize = getSize; // funktion der returnerer {w,h}
      this.cfg = { ...DEFAULTS };
      this._key = '';
      this.env = { cat: 'clear', night: true };

      // Mobil får lavere kvalitet fra start (færre partikler osv.)
      this.mobile =
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
        Math.min(screen.width, screen.height) < 700;
      this.quality = this.mobile ? 0.6 : 1;

      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.t = 0; // animationstid (skaleret med speed)
      this.last = 0;
      this.raf = 0;
      this.running = false;
      this.mouse = { x: 0, y: 0, active: false };
      this.s = {}; // data til den valgte stil
      this.o = {}; // data til vejr-overlay
      this.lv = { rain: 0, snow: 0, fog: 0, stars: 0 }; // overlay-niveauer (fader ind/ud)
      this.pal = null;
      this.flash = 0;
      this.nextFlash = rnd(4, 9);
      this.afterT = 0;
      this.glow = 0;
      this.bolt = null;
      this.slowAcc = 0;
      this.slowN = 0;
      this.cool = 0;
      this.mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

      this._frame = this._frame.bind(this);
      this._onMove = (ev) => {
        const r = this.canvas.getBoundingClientRect();
        this.mouse.x = ev.clientX - r.left;
        this.mouse.y = ev.clientY - r.top;
        this.mouse.active = true;
        clearTimeout(this._mt);
        if (ev.pointerType === 'touch') {
          this._mt = setTimeout(() => (this.mouse.active = false), 2000);
        }
      };
      this._onOut = (ev) => {
        if (!ev.relatedTarget) this.mouse.active = false;
      };
    }

    setConfig(cfg) {
      const next = { ...DEFAULTS, ...cfg };
      if (!STYLES[next.style]) next.style = 'particles';
      const key = JSON.stringify(next);
      if (key === this._key) return;
      this._key = key;
      this.cfg = next;
      if (this.w) {
        this._initStyle();
        this._initOverlays();
      }
      this._bindMouse();
    }

    _bindMouse() {
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerout', this._onOut);
      if (this.cfg.interaction && this.running) {
        window.addEventListener('pointermove', this._onMove, { passive: true });
        window.addEventListener('pointerout', this._onOut, { passive: true });
      }
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      this._bindMouse();
      this.raf = requestAnimationFrame(this._frame);
    }

    stop() {
      this.running = false;
      cancelAnimationFrame(this.raf);
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerout', this._onOut);
    }

    // Tilpasser canvas til størrelsen. Nulstiller kun animationen ved stor ændring.
    _fit() {
      const sz = this.getSize();
      const w = Math.max(1, Math.round(sz.w));
      const h = Math.max(1, Math.round(sz.h));
      const dpr = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2);
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      const reinit = !this.w || w !== this.w || Math.abs(h - this.h) > 150;
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reinit) {
        this._initStyle();
        this._initOverlays();
      }
    }

    _initStyle() {
      this.s = {};
      (STYLES[this.cfg.style] || STYLES.particles).init(this);
    }

    _initOverlays() {
      const { w, h, quality } = this;
      const q = quality;
      // Regn i tre dybdelag: tynd og svag langt væk, tykkere, lysere og hurtigere tæt på. Længde og fart varierer.
      const nr = Math.round(clamp((w * h) / 3200, 80, 480) * q);
      this.o.rain = Array.from({ length: nr }, (_, i) => {
        const layer = i % 5 < 2 ? 0 : i % 5 < 4 ? 1 : 2; // 40 % langt væk, 40 % midt, 20 % tæt på
        const k = [0, 0.5, 1][layer];
        return {
          layer,
          x: rnd(-100, w),
          y: rnd(-h, h),
          l: rnd(8, 15) * (1 + k * 1.1) * rnd(0.75, 1.3),
          v: rnd(560, 800) * (1 + k * 0.55) * rnd(0.85, 1.15),
        };
      });
      // Sne: z = dybde (0 langt væk, 1 tæt på). Tæt på: store bløde fnug (de største som krystaller). Langt væk: små skarpe.
      this.o.snow = Array.from({ length: Math.round(clamp((w * h) / 5500, 60, 300) * q) }, () => {
        const z = Math.random();
        const crystal = z > 0.55 && Math.random() < 0.16;
        const r = crystal ? rnd(7, 11) : 1.2 + z * z * 4.5 + rnd(0, 1.2);
        return {
          z,
          crystal,
          kind: crystal ? 2 : z > 0.7 ? 0 : 1, // 0 blød, 1 skarp, 2 krystal
          x: rnd(0, w),
          y: rnd(0, h),
          r,
          v: rnd(22, 40) * (0.45 + z * 1.1),
          ph: rnd(0, TAU),
          sw: rnd(0.4, 1.3),
          amp: rnd(8, 24) * (0.5 + z * 0.8),
          rot: rnd(0, TAU),
          spin: rnd(-0.6, 0.6),
          a: clamp(0.35 + z * 0.5, 0, 0.9),
        };
      });
      const m = Math.max(w, h);
      this.o.fog = Array.from({ length: 6 }, (_, i) => ({
        x: rnd(0, w),
        y: h * (0.15 + i * 0.14) + rnd(-30, 30),
        s: rnd(0.5, 1.1) * m * 0.6,
        vx: rnd(8, 22) * (Math.random() < 0.5 ? 1 : -1),
        a: rnd(0.05, 0.12),
      }));
      this.o.stars = Array.from({ length: Math.round(clamp((w * h) / 12000, 30, 110) * q) }, () => ({
        x: rnd(0, w),
        y: rnd(0, h),
        r: rnd(0.5, 1.5),
        ph: rnd(0, TAU),
        tw: rnd(0.5, 2),
      }));
    }

    // Nuværende palette glider langsomt mod målpaletten (blød overgang)
    _target() {
      const c = this.cfg;
      const { cat, night } = this.env;
      if (c.color_mode === 'manual') {
        const p = parseColor(c.color_primary, [79, 163, 255]);
        const s = parseColor(c.color_secondary, [170, 90, 255]);
        return {
          bg0: p.map((v) => v * 0.1),
          bg1: mix(p, s, 0.5).map((v) => v * 0.22),
          p,
          s,
          a: mix(p, [255, 255, 255], 0.5),
        };
      }
      const set = PALETTES[cat === 'pour' ? 'rain' : cat] || PALETTES.clear;
      const v = night ? set.night : set.day;
      return { bg0: v[0], bg1: v[1], p: v[2], s: v[3], a: v[4] };
    }

    _updatePalette(dt) {
      const tg = this._target();
      if (!this.pal) {
        this.pal = {};
        for (const k in tg) this.pal[k] = tg[k].slice();
        return;
      }
      const f = 1 - Math.exp(-dt * 1.5);
      for (const k in tg) for (let i = 0; i < 3; i++) this.pal[k][i] = lerp(this.pal[k][i], tg[k][i], f);
    }

    _frame(now) {
      if (!this.running) return;
      this.raf = requestAnimationFrame(this._frame);
      const interval = 1000 / clamp(this.cfg.max_fps, 10, 120);
      if (now < (this._due || 0) - 1) return; // FPS-loft (fast tidsplan, så 40 fps bliver ~40 og ikke 30)
      this._due = Math.max((this._due || now) + interval, now);

      // Intet at tegne (animation og vejr-overlay slået fra + en baggrund valgt):
      // ryd canvas'et én gang og spring resten over, så kortet næsten ikke koster noget
      if (this._idle()) {
        if (!this._cleared) {
          this.ctx.clearRect(0, 0, this.w, this.h);
          this._cleared = true;
        }
        this.last = now;
        return;
      }
      this._cleared = false;

      const real = now - this.last;
      const dt = Math.min(real / 1000, 0.1);
      this.last = now;

      this._fit();
      this._adaptQuality(real, interval);

      const reduced = this.cfg.respect_reduced_motion && this.mq && this.mq.matches;
      const sdt = dt * this.cfg.speed * (reduced ? 0.25 : 1);
      this.t += sdt;
      this._updatePalette(dt);
      this._draw(dt, sdt, reduced);
    }

    _idle() {
      const c = this.cfg;
      const weather = c.weather_overlay && (c.rain || c.snow || c.fog || c.stars);
      return !c.animation_enabled && !weather && c.background_source !== 'none';
    }

    // Hvis enheden ikke kan følge med, sænkes antallet af partikler automatisk
    _adaptQuality(real, interval) {
      if (this.cool > 0) {
        this.cool--;
        return;
      }
      this.slowAcc += real;
      this.slowN++;
      if (this.slowN >= 60) {
        const avg = this.slowAcc / this.slowN;
        this.slowAcc = 0;
        this.slowN = 0;
        if (avg > interval * 1.6 && this.quality > 0.4) {
          this.quality = Math.max(0.4, this.quality * 0.75);
          // Kun stile, der bruger kvalitet (q), nulstilles. Ellers ville animationen starte forfra.
          if ((STYLES[this.cfg.style] || {}).q) this._initStyle();
          this._initOverlays();
          this.cool = 120;
        }
      }
    }

    _draw(dt, sdt, reduced) {
      const { ctx, w, h, cfg, pal } = this;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);

      if (cfg.fill_background && cfg.background_source === 'none') {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, rgba(pal.bg0, 1));
        g.addColorStop(1, rgba(pal.bg1, 1));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      if (cfg.animation_enabled) {
        ctx.globalAlpha = cfg.opacity;
        (STYLES[cfg.style] || STYLES.particles).draw(this, sdt);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // Støj mod farvetrin (se noisePattern). Styrke 1 = 0-5 ud af 255.
      if (cfg.dither && cfg.dither_strength > 0 && (cfg.animation_enabled || cfg.background_source === 'none')) {
        const amp = clamp(Math.round(5 * cfg.dither_strength), 1, 12);
        if (!this._noise || this._noiseAmp !== amp) {
          this._noise = noisePattern(ctx, amp);
          this._noiseAmp = amp;
        }
        // Mønsteret flyttes tilfældigt hver frame, så støjen ikke står stille som en struktur
        const ox = (Math.random() * 256) | 0;
        const oy = (Math.random() * 256) | 0;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, ox, oy); // én støjprik pr. rigtig pixel
        ctx.fillStyle = this._noise;
        ctx.fillRect(-ox, -oy, this.canvas.width, this.canvas.height);
        ctx.restore();
      }

      if (cfg.weather_overlay && !reduced) this._overlays(dt, sdt);
    }

    /* ---------- Vejr-overlay ---------- */
    _overlays(dt, sdt) {
      const c = this.cfg;
      const { cat, night } = this.env;
      const target = {
        rain: c.rain && (cat === 'rain' || cat === 'pour' || cat === 'storm') ? (cat === 'pour' || cat === 'storm' ? 1.8 : 1) : 0,
        snow: c.snow && cat === 'snow' ? 1 : 0,
        fog: c.fog && cat === 'fog' ? 1 : 0,
        stars: c.stars && night && (cat === 'clear' || cat === 'partly') && c.style !== 'starfield' ? 1 : 0,
      };
      const f = 1 - Math.exp(-dt * 1.2);
      for (const k in target) this.lv[k] += (target[k] - this.lv[k]) * f;

      if (this.lv.fog > 0.01) this._fog(sdt);
      if (this.lv.stars > 0.01) this._starsLayer();
      if (this.lv.snow > 0.01) this._snow(sdt);
      if (this.lv.rain > 0.01) this._rain(dt, sdt);
    }

    _rain(dt, sdt) {
      const { ctx, w, h } = this;
      const R = this.o.rain;
      const n = Math.floor(R.length * clamp(this.lv.rain / 1.8, 0, 1));
      const slant = 0.18 + 0.07 * Math.sin(this.t * 0.35) + 0.04 * Math.sin(this.t * 1.1); // vindstød
      const base = this.env.night ? 0.28 : 0.38;
      ctx.lineCap = 'round';
      for (let layer = 0; layer < 3; layer++) {
        ctx.lineWidth = [0.7, 1.1, 1.8][layer];
        ctx.strokeStyle = rgba([190, 215, 255], base * [0.5, 0.9, 1.35][layer]);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const d = R[i];
          if (d.layer !== layer) continue;
          d.y += d.v * sdt;
          d.x += d.v * slant * sdt;
          if (d.y > h + 20) {
            d.y = -rnd(20, 200);
            d.x = rnd(-100, w);
          }
          if (d.x > w + 50) d.x -= w + 100;
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - slant * d.l, d.y - d.l);
        }
        ctx.stroke();
      }

      // Torden: af og til et forgrenet lyn med efterblink; ellers kun lysglimt bag skyerne
      if (this.env.cat === 'storm' && this.lv.rain > 0.3) {
        this.nextFlash -= dt;
        if (this.nextFlash <= 0) {
          this.flash = 1;
          this.afterT = rnd(0.1, 0.18); // kort pause, så blinker det igen
          this.glow = 1;
          this.bolt = Math.random() < 0.65 ? makeBolt(w, h) : null;
          this.nextFlash = rnd(5, 12);
        }
        if (this.afterT > 0) {
          this.afterT -= dt;
          if (this.afterT <= 0) this.flash = Math.max(this.flash, 0.75);
        }
        if (this.flash > 0.01) {
          ctx.fillStyle = rgba([220, 225, 255], this.flash * 0.26);
          ctx.fillRect(0, 0, w, h);
          if (this.bolt) {
            const f = clamp(this.flash, 0, 1);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            for (const [lw, al, col] of [[7, 0.16, [170, 190, 255]], [2.6, 0.55, [215, 225, 255]], [1.1, 0.95, [255, 255, 255]]]) {
              for (let depth = 0; depth < 3; depth++) {
                ctx.lineWidth = lw * [1, 0.6, 0.35][depth];
                ctx.strokeStyle = rgba(col, al * f);
                ctx.beginPath();
                for (const sg of this.bolt) {
                  if (sg[4] !== depth) continue;
                  ctx.moveTo(sg[0], sg[1]);
                  ctx.lineTo(sg[2], sg[3]);
                }
                ctx.stroke();
              }
            }
          }
          this.flash *= Math.exp(-dt * 7);
        } else this.bolt = null;
        // Efterglød: himlen lyser svagt og aftager langsomt
        if (this.glow > 0.01) {
          ctx.fillStyle = rgba([200, 210, 255], this.glow * 0.07);
          ctx.fillRect(0, 0, w, h);
          this.glow *= Math.exp(-dt * 1.4);
        }
      }
    }

    _snow(sdt) {
      const { ctx, w, h } = this;
      const sp = snowSprites();
      const wind = Math.sin(this.t * 0.23) * 18 + Math.sin(this.t * 0.71 + 1) * 9; // vindstød, px/s
      const lv = this.lv.snow;
      for (const f of this.o.snow) {
        const zf = 0.4 + f.z * 0.9; // tæt på påvirkes mest af vinden
        f.y += f.v * sdt;
        f.x += (Math.sin(this.t * f.sw + f.ph) * f.amp + wind * zf) * sdt;
        f.rot += f.spin * sdt;
        if (f.y > h + 14) {
          f.y = -14;
          f.x = rnd(0, w);
        }
        if (f.x < -14) f.x = w + 14;
        else if (f.x > w + 14) f.x = -14;
        ctx.globalAlpha = f.a * lv;
        if (f.kind === 2) {
          ctx.save();
          ctx.translate(f.x, f.y);
          ctx.rotate(f.rot);
          ctx.drawImage(sp.crystal, -f.r, -f.r, f.r * 2, f.r * 2);
          ctx.restore();
        } else if (f.kind === 0) {
          const d = f.r * 2.6;
          ctx.drawImage(sp.soft, f.x - d / 2, f.y - d / 2, d, d);
        } else {
          const d = f.r * 2;
          ctx.drawImage(sp.crisp, f.x - f.r, f.y - f.r, d, d);
        }
      }
      ctx.globalAlpha = 1;
    }

    _fog(sdt) {
      const { ctx, w } = this;
      const spr = fogSprite();
      const dim = this.env.night ? 0.55 : 1;
      for (const b of this.o.fog) {
        b.x += b.vx * sdt;
        if (b.x > w + b.s / 2) b.x = -b.s / 2;
        else if (b.x < -b.s / 2) b.x = w + b.s / 2;
        ctx.globalAlpha = b.a * this.lv.fog * dim * 2;
        ctx.drawImage(spr, b.x - b.s / 2, b.y - b.s / 2, b.s, b.s);
      }
      ctx.globalAlpha = 1;
    }

    _starsLayer() {
      const { ctx } = this;
      for (const s of this.o.stars) {
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.t * s.tw + s.ph));
        ctx.fillStyle = rgba(this.pal.a, tw * this.lv.stars);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, TAU);
        ctx.fill();
      }
    }
  }

  /* ======================================================================
   * 5. STILARTER
   *    Hver stil har to funktioner:
   *      init(e)     - kører når stilen vælges eller skærmen ændres. Opretter stilens objekter.
   *      draw(e, dt) - kører hver frame. Flytter og tegner.
   *    e er Engine'n:  e.ctx (tegnefladen), e.w / e.h (størrelse), e.cfg (indstillinger),
   *    e.pal (aktuelle farver), e.t (tid), e.mouse, e.quality, e.s (stilens egen data).
   *    En ny stil oprettes ved at kopiere en eksisterende, give den et nyt navn og tilføje
   *    navnet i STYLE_IDS (sektion 9) samt en style_<navn>-tekst i STRINGS (sektion 8).
   * ==================================================================== */
  // Strømning: ét spor = en lille ringbuffer af punkter. Hovedet følger et langsomt skiftende strømningsfelt.
  function flowPush(p, x, y, L) {
    p.head = (p.head + 1) % L;
    p.xs[p.head] = x;
    p.ys[p.head] = y;
    if (p.n < L) p.n++;
  }

  function flowSpawn(e, p) {
    p.head = 0;
    p.n = 0;
    p.live = true;
    p.life = rnd(3, 9); // sekunder, før sporet løber ud
    p.sp = rnd(0.75, 1.25);
    flowPush(p, rnd(0, e.w), rnd(0, e.h), e.s.L);
  }

  // Strømfunktion: strømningen er "krøllen" af denne (curl-støj). Det giver et felt uden kilder og dræn, så sporene
  // fordeler sig jævnt i stedet for at samle sig et sted.
  function flowPsi(x, y, k, t) {
    return Math.sin(x * k + t * 0.21 + 1.3 * Math.sin(y * k * 0.7 + t * 0.13)) + Math.sin(y * k * 1.1 - t * 0.17 + 1.1 * Math.sin(x * k * 0.8 - t * 0.11));
  }

  function flowStep(e, p, dt, wind) {
    const { w, h, t, cfg, mouse } = e;
    const L = e.s.L;
    const k = 0.005 / cfg.flow_scale; // feltets frekvens
    const x = p.xs[p.head];
    const y = p.ys[p.head];
    const eps = 3;
    const gx = (flowPsi(x + eps, y, k, t) - flowPsi(x - eps, y, k, t)) / (2 * eps);
    const gy = (flowPsi(x, y + eps, k, t) - flowPsi(x, y - eps, k, t)) / (2 * eps);
    const sc = (90 * cfg.flow_speed * p.sp * (1 + 0.35 * wind)) / (k * 1.6);
    const vx = gy * sc; // hastighed = krøllen af strømfunktionen
    const vy = -gx * sc;
    let nx = x + vx * dt + wind * 55 * dt;
    let ny = y + vy * dt + wind * 18 * dt;
    // Glattet retning (bruges til farven)
    const m = Math.hypot(vx, vy) || 1;
    const f = Math.min(1, dt * 3);
    p.hx += (vx / m - p.hx) * f;
    p.hy += (vy / m - p.hy) * f;
    if (cfg.interaction && mouse.active) {
      const dx = nx - mouse.x;
      const dy = ny - mouse.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 12100 && d2 > 1) {
        const d = Math.sqrt(d2);
        const g = ((110 - d) / 110) * 120 * dt;
        nx += (dx / d) * g;
        ny += (dy / d) * g;
      }
    }
    flowPush(p, nx, ny, L);
    if (nx < -30 || nx > w + 30 || ny < -30 || ny > h + 30) p.live = false;
  }

  // Netværk: ruter og hjælpefunktioner. En forbindelse er en række punkter. Formen kan være vinklet (rette vinkler),
  // diagonal (45°-knæk som på et printkort), kurvet eller lige. "mixed" vælger en tilfældig form pr. linje.
  function netRoute(a, b, shape) {
    if (shape === 'mixed') shape = ['angled', 'diagonal', 'curved', 'straight'][(Math.random() * 4) | 0];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (shape === 'straight' || dx === 0 || dy === 0) return [[a.x, a.y], [b.x, b.y]];
    if (shape === 'diagonal') {
      const sx = Math.sign(dx);
      const sy = Math.sign(dy);
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      let p;
      if (Math.random() < 0.5) p = ax > ay ? [a.x + sx * (ax - ay), a.y] : [a.x, a.y + sy * (ay - ax)]; // lige stykke først, så 45°
      else p = ax > ay ? [a.x + sx * ay, b.y] : [b.x, a.y + sy * ax]; // 45° først, så lige stykke
      return [[a.x, a.y], p, [b.x, b.y]];
    }
    if (shape === 'curved') {
      // Kubisk kurve med blød S-form langs den længste akse
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const c1 = horiz ? [a.x + dx * 0.5, a.y] : [a.x, a.y + dy * 0.5];
      const c2 = horiz ? [b.x - dx * 0.5, b.y] : [b.x, b.y - dy * 0.5];
      const pts = [];
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const u = 1 - t;
        pts.push([
          u * u * u * a.x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b.x,
          u * u * u * a.y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b.y,
        ]);
      }
      return pts;
    }
    if (Math.random() < 0.5) {
      const mx = Math.round((a.x + b.x) / 20) * 10;
      return [[a.x, a.y], [mx, a.y], [mx, b.y], [b.x, b.y]];
    }
    const my = Math.round((a.y + b.y) / 20) * 10;
    return [[a.x, a.y], [a.x, my], [b.x, my], [b.x, b.y]];
  }

  // Netværk: farvesæt (links, knuder, hubs, pakker)
  function netColors(mode, pal) {
    switch (mode) {
      case 'cyber':
        return { lc: [0, 190, 255], nc: [120, 230, 255], hc: [255, 60, 200], pc: [255, 200, 245] };
      case 'amber':
        return { lc: [220, 140, 0], nc: [255, 200, 90], hc: [255, 170, 40], pc: [255, 235, 190] };
      case 'red':
        return { lc: [200, 40, 50], nc: [255, 110, 90], hc: [255, 60, 60], pc: [255, 210, 190] };
      case 'ice':
        return { lc: [120, 170, 230], nc: [210, 235, 255], hc: [160, 205, 255], pc: [255, 255, 255] };
      case 'palette':
        return { lc: pal.s, nc: pal.a, hc: mix(pal.p, [255, 255, 255], 0.3), pc: mix(pal.p, [255, 255, 255], 0.6) };
      default:
        return { lc: [0, 190, 130], nc: [140, 255, 210], hc: [90, 225, 255], pc: [215, 255, 240] };
    }
  }

  // Position på en forbindelse, d pixel fra start
  function netPos(l, d, out) {
    const P = l.pts;
    const C = l.cum;
    d = clamp(d, 0, l.len);
    let i = 1;
    while (i < P.length - 1 && C[i] < d) i++;
    const seg = C[i] - C[i - 1] || 1;
    const f = (d - C[i - 1]) / seg;
    out.x = P[i - 1][0] + (P[i][0] - P[i - 1][0]) * f;
    out.y = P[i - 1][1] + (P[i][1] - P[i - 1][1]) * f;
    return out;
  }

  const netHex = () => '0x' + ((Math.random() * 65536) | 0).toString(16).toUpperCase().padStart(4, '0');
  const netIp = () => `10.${(Math.random() * 8) | 0}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 253) | 0)}`;

  // Retro: skyline som art deco-bygninger i to lag. Returnerer fyld, neonkant og vinduer.
  function retroCity(w, hor, h, l, sc) {
    const fill = new Path2D();
    const edge = new Path2D();
    const win0 = new Path2D();
    const win1 = new Path2D();
    const maxH = h * (l === 0 ? 0.22 : 0.14);
    let x = -10;
    while (x < w + 10) {
      const bw = rnd(16, 46) * sc * (l === 0 ? 0.95 : 1.15);
      const valley = 0.3 + 0.7 * Math.pow(Math.abs((2 * x) / w - 1), 1.1); // lavere midt for, så solen kan ses
      const bh = 10 + (0.2 + 0.8 * Math.pow(Math.random(), 1.4)) * maxH * valley;
      const top = hor - bh;
      fill.rect(x, top, bw, bh + 2);
      edge.moveTo(x, hor);
      edge.lineTo(x, top);
      let tx = x;
      let tw = bw;
      let ty = top;
      // Art deco: en eller to smallere etager øverst
      const tiers = Math.random() < 0.6 ? (Math.random() < 0.4 ? 2 : 1) : 0;
      for (let t = 0; t < tiers; t++) {
        const nw = tw * rnd(0.5, 0.75);
        const nh = bh * rnd(0.12, 0.28);
        const nx = tx + (tw - nw) / 2;
        edge.lineTo(tx, ty);
        edge.lineTo(nx, ty);
        edge.lineTo(nx, ty - nh);
        fill.rect(nx, ty - nh, nw, nh + 1);
        tx = nx;
        tw = nw;
        ty -= nh;
      }
      edge.lineTo(tx, ty);
      edge.lineTo(tx + tw, ty);
      // Antenne på nogle
      if (Math.random() < 0.25) {
        const ax = tx + tw / 2;
        const ah = rnd(8, 22) * sc;
        fill.rect(ax - 0.8, ty - ah, 1.6, ah);
      }
      // Højre side ned igen (via de samme etager)
      edge.lineTo(tx + tw, ty);
      edge.lineTo(x + bw, top);
      edge.lineTo(x + bw, hor);
      // Vinduer i forreste lag
      if (l === 1 && bw > 20 * sc) {
        for (let wy = top + 8; wy < hor - 6; wy += 9) {
          for (let wx = x + 5; wx < x + bw - 6; wx += 7) {
            const r = Math.random();
            if (r < 0.22) win0.rect(wx, wy, 2, 3);
            else if (r < 0.3) win1.rect(wx, wy, 2, 3);
          }
        }
      }
      x += bw + rnd(0, 4);
    }
    return { fill, edge, win0, win1 };
  }

  const STYLES = {
    /* ---- 1. Partikler med linjer (login-look) ---- */
    particles: {
      q: true,
      init(e) {
        const n = Math.round(clamp((e.w * e.h) / 16000, 25, 120) * e.cfg.density * e.quality);
        e.s.p = Array.from({ length: n }, () => ({
          x: rnd(0, e.w),
          y: rnd(0, e.h),
          vx: rnd(-1, 1) * 22,
          vy: rnd(-1, 1) * 22,
          r: rnd(0.8, 2.2) * e.cfg.particles_size,
        }));
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg, mouse } = e;
        const P = e.s.p;
        const L = cfg.particles_line_distance;
        const L2 = L * L;
        const useM = cfg.interaction && mouse.active;

        for (const p of P) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (useM) {
            // Mus/touch skubber blidt til partiklerne
            const dx = p.x - mouse.x;
            const dy = p.y - mouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < 12100 && d2 > 1) {
              const d = Math.sqrt(d2);
              const f = ((110 - d) / 110) * 90 * dt;
              p.x += (dx / d) * f;
              p.y += (dy / d) * f;
            }
          }
          if (p.x < -20) p.x = w + 20;
          else if (p.x > w + 20) p.x = -20;
          if (p.y < -20) p.y = h + 20;
          else if (p.y > h + 20) p.y = -20;
        }

        // Linjer mellem partikler tæt på hinanden
        ctx.lineWidth = 1;
        for (let i = 0; i < P.length; i++) {
          const a = P[i];
          for (let j = i + 1; j < P.length; j++) {
            const b = P[j];
            const dx = a.x - b.x;
            if (dx > L || dx < -L) continue;
            const dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < L2) {
              ctx.strokeStyle = rgba(pal.s, (1 - Math.sqrt(d2) / L) * cfg.particles_line_opacity);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
          }
        }

        // Linjer fra musen til nærliggende partikler
        if (useM) {
          for (const p of P) {
            const dx = p.x - mouse.x;
            const dy = p.y - mouse.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < L * 1.2) {
              ctx.strokeStyle = rgba(pal.a, (1 - d / (L * 1.2)) * cfg.particles_line_opacity * 1.4);
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(mouse.x, mouse.y);
              ctx.stroke();
            }
          }
        }

        // Selve prikkerne tegnes i ét samlet pas
        ctx.fillStyle = rgba(pal.p, 0.9);
        ctx.beginPath();
        for (const p of P) {
          ctx.moveTo(p.x + p.r, p.y);
          ctx.arc(p.x, p.y, p.r, 0, TAU);
        }
        ctx.fill();
      },
    },

    /* ---- 2. Netværk: knudepunkter (hubs) med grene, printkort-linjer, datapakker og scanninger ----
     *  Strukturen laves én gang (init): få hubs, klynger af små knuder omkring dem og forbindelser imellem.
     *  Hver frame flytter kun pakker og ringe, så stilen er billig. */
    network: {
      q: true,
      init(e) {
        const c = e.cfg;
        const W = e.w;
        const H = e.h;
        const sc = clamp(Math.min(W, H) / 700, 0.8, 1.4);
        const shape = c.network_shape;
        const nh = clamp(Math.round(((W * H) / 50000) * c.density * e.quality), 4, 14);
        const m = Math.min(W, H) * 0.1;
        const snap = (v) => Math.round(v / 10) * 10;
        const nodes = [];
        const links = [];
        const hubs = [];
        // Hubs: bedste af nogle tilfældige forsøg, så de ligger spredt
        for (let i = 0; i < nh; i++) {
          let best = null;
          let bd = -1;
          for (let k = 0; k < 14; k++) {
            const x = snap(rnd(m, W - m));
            const y = snap(rnd(m, H - m));
            let d = Infinity;
            for (const o of hubs) d = Math.min(d, Math.hypot(o.x - x, o.y - y));
            if (d > bd) {
              bd = d;
              best = { x, y };
            }
          }
          const hub = { x: best.x, y: best.y, hub: true, r: 4.2 * c.network_size, fl: 0, links: [], lab: netIp(), labT: 0, ph: rnd(0, TAU) };
          hubs.push(hub);
          nodes.push(hub);
        }
        const link = (a, b) => {
          const pts = netRoute(a, b, shape);
          const cum = [0];
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
          const l = { a, b, pts, cum, len: cum[cum.length - 1], hh: a.hub && b.hub };
          links.push(l);
          a.links.push(l);
          b.links.push(l);
        };
        // Grene: små knuder i en klynge omkring hver hub
        for (const hub of hubs) {
          const nl = Math.max(2, Math.round(rnd(4, 8) * clamp(c.density, 0.5, 1.5) * e.quality));
          const mine = [];
          for (let i = 0; i < nl; i++) {
            for (let tries = 0; tries < 8; tries++) {
              const ang = rnd(0, TAU);
              const rad = rnd(55, 170) * sc * c.network_distance;
              const x = snap(hub.x + Math.cos(ang) * rad);
              const y = snap(hub.y + Math.sin(ang) * rad);
              if (x < 8 || x > W - 8 || y < 8 || y > H - 8) continue;
              if (nodes.some((o) => Math.hypot(o.x - x, o.y - y) < 26)) continue;
              const leaf = { x, y, hub: false, r: rnd(2.1, 3.1) * c.network_size, fl: 0, links: [], lab: netHex(), labT: 0, home: hub };
              nodes.push(leaf);
              link(hub, leaf);
              if (mine.length && Math.random() < 0.45) link(mine[mine.length - 1], leaf); // enkelte tværforbindelser
              mine.push(leaf);
              break;
            }
          }
        }
        // Hubs forbindes med deres nærmeste nabo(er)
        const done = new Set();
        hubs.forEach((a, i) => {
          const near = hubs
            .map((b, j) => ({ b, j, d: Math.hypot(a.x - b.x, a.y - b.y) }))
            .filter((o) => o.j !== i)
            .sort((x, y) => x.d - y.d)
            .slice(0, 2);
          for (const o of near) {
            const key = Math.min(i, o.j) + '-' + Math.max(i, o.j);
            if (!done.has(key)) {
              done.add(key);
              link(a, o.b);
            }
          }
        });
        e.s.nodes = nodes;
        e.s.hubs = hubs;
        e.s.links = links;
        e.s.pk = []; // datapakker
        e.s.rings = []; // scanningsringe
        e.s.sp = rnd(0.2, 0.6);
        e.s.rt = rnd(1, 3);
        e.s.mt = 0;
        e.s.sc = sc;
        const dot = document.createElement('canvas');
        dot.width = dot.height = 32;
        e.s.dot = dot;
        e.s.tmp = { x: 0, y: 0 };
      },
      draw(e, dt) {
        const { ctx, pal, cfg, mouse } = e;
        const s = e.s;
        const N = s.nodes;
        const sc = s.sc;
        const { lc, nc, hc, pc } = netColors(cfg.network_color, pal);
        const rate = cfg.network_rate;

        for (const n of N) {
          n.fl *= Math.exp(-dt * 2.5);
          if (n.labT > 0) n.labT -= dt;
        }

        // Pakker: starter i en hub, løber langs en forbindelse og fortsætter ofte videre
        const startPk = (n) => {
          if (!n.links.length || s.pk.length > 40) return;
          const l = n.links[(Math.random() * n.links.length) | 0];
          const fwd = l.a === n;
          s.pk.push({ l, dir: fwd ? 1 : -1, d: fwd ? 0 : l.len, hop: 0 });
          n.fl = Math.max(n.fl, 0.7);
          if (cfg.network_labels) n.labT = 1.4;
        };
        if (rate > 0) {
          s.sp -= dt;
          if (s.sp <= 0) {
            startPk(s.hubs[(Math.random() * s.hubs.length) | 0]);
            s.sp = rnd(0.3, 0.9) / (rate * Math.max(0.5, s.hubs.length / 5));
          }
          if (cfg.network_scan) {
            s.rt -= dt;
            if (s.rt <= 0 && s.rings.length < 3) {
              s.rings.push({ n: s.hubs[(Math.random() * s.hubs.length) | 0], r: 0 });
              s.rt = rnd(4, 9) / rate;
            }
          }
        }
        if (cfg.interaction && mouse.active) {
          s.mt -= dt;
          if (s.mt <= 0) {
            s.mt = 0.35;
            let best = null;
            let bd = 160 * 160;
            for (const n of N) {
              const d2 = (n.x - mouse.x) * (n.x - mouse.x) + (n.y - mouse.y) * (n.y - mouse.y);
              if (d2 < bd) {
                bd = d2;
                best = n;
              }
            }
            if (best) startPk(best);
          }
        }
        const speed = 140 * cfg.network_speed * sc;
        for (let i = s.pk.length - 1; i >= 0; i--) {
          const p = s.pk[i];
          p.d += p.dir * speed * dt;
          if ((p.dir > 0 && p.d >= p.l.len) || (p.dir < 0 && p.d <= 0)) {
            const n = p.dir > 0 ? p.l.b : p.l.a;
            n.fl = 1;
            if (cfg.network_labels && !n.hub) n.labT = 1.6;
            const others = n.links.filter((l) => l !== p.l);
            if (p.hop < 5 && others.length && Math.random() < 0.65) {
              const l = others[(Math.random() * others.length) | 0];
              const fwd = l.a === n;
              p.l = l;
              p.dir = fwd ? 1 : -1;
              p.d = fwd ? 0 : l.len;
              p.hop++;
            } else s.pk.splice(i, 1);
          }
        }

        // Linjer: hub-til-hub tydeligst, grenene svagere
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let g = 0; g < 2; g++) {
          ctx.lineWidth = g ? 1.4 : 1;
          ctx.strokeStyle = rgba(g ? hc : lc, g ? 0.7 : 0.5);
          ctx.beginPath();
          for (const l of s.links) {
            if (l.hh !== !!g) continue;
            ctx.moveTo(l.pts[0][0], l.pts[0][1]);
            for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i][0], l.pts[i][1]);
          }
          ctx.stroke();
        }

        // Scanningsringe fra en hub. Knuder blinker, når ringen passerer dem.
        const R = 230 * sc * cfg.network_distance;
        for (let i = s.rings.length - 1; i >= 0; i--) {
          const r = s.rings[i];
          r.r += 150 * sc * cfg.network_speed * dt;
          if (r.r > R) {
            s.rings.splice(i, 1);
            continue;
          }
          const a = (1 - r.r / R) * 0.55;
          ctx.strokeStyle = rgba(hc, a);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(r.n.x, r.n.y, r.r, 0, TAU);
          ctx.stroke();
          for (const n of N) {
            if (n === r.n) continue;
            const d = Math.hypot(n.x - r.n.x, n.y - r.n.y);
            if (Math.abs(d - r.r) < 5) {
              n.fl = Math.max(n.fl, 0.85);
              if (cfg.network_labels && !n.hub) n.labT = 1.2;
            }
          }
        }

        // Knuder som små firkanter (hubs større, med ramme)
        ctx.fillStyle = rgba(nc, 0.85);
        ctx.beginPath();
        for (const n of N) if (!n.hub) ctx.rect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
        ctx.fill();
        ctx.lineWidth = 1.3;
        ctx.strokeStyle = rgba(hc, 0.9);
        ctx.fillStyle = rgba(hc, 0.35);
        ctx.beginPath();
        for (const n of s.hubs) ctx.rect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
        ctx.fill();
        ctx.stroke();
        // Blink: en ring udad omkring knuden
        for (const n of N) {
          if (n.fl < 0.05) continue;
          const g = n.r + 3 + (1 - n.fl) * 10;
          ctx.strokeStyle = rgba(n.hub ? hc : nc, n.fl * 0.8);
          ctx.lineWidth = 1;
          ctx.strokeRect(n.x - g, n.y - g, g * 2, g * 2);
        }

        // Glød (svag på hubs, kraftig ved blink) og på pakkerne
        if (cfg.network_glow) {
          const dg = s.dot.getContext('2d');
          dg.clearRect(0, 0, 32, 32);
          const gc = mix(nc, [255, 255, 255], 0.2);
          const gr = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
          gr.addColorStop(0, rgba(gc, 1));
          gr.addColorStop(0.3, rgba(gc, 0.4));
          gr.addColorStop(1, rgba(gc, 0));
          dg.fillStyle = gr;
          dg.fillRect(0, 0, 32, 32);
          ctx.globalCompositeOperation = 'lighter';
          for (const n of N) {
            const a = (n.hub ? 0.22 : 0.05) + 0.85 * n.fl;
            if (a < 0.06) continue;
            ctx.globalAlpha = Math.min(1, a);
            const d = n.r * (n.hub ? 6 : 5) + n.fl * 10;
            ctx.drawImage(s.dot, n.x - d, n.y - d, d * 2, d * 2);
          }
          const pos = s.tmp;
          ctx.globalAlpha = 0.9;
          for (const p of s.pk) {
            netPos(p.l, p.d, pos);
            ctx.drawImage(s.dot, pos.x - 9, pos.y - 9, 18, 18);
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }

        // Datapakker: en lille firkant med et spor af svagere firkanter bagved
        const pos = s.tmp;
        for (let tr = 3; tr >= 0; tr--) {
          ctx.fillStyle = rgba(pc, tr ? 0.5 / tr : 1);
          const q = tr ? 2.4 - tr * 0.3 : 3.2;
          ctx.beginPath();
          for (const p of s.pk) {
            netPos(p.l, p.d - p.dir * tr * 6, pos);
            ctx.rect(pos.x - q / 2, pos.y - q / 2, q, q);
          }
          ctx.fill();
        }

        // Små tekster: hubs har deres adresse, grene viser en kode, når et signal rammer dem
        if (cfg.network_labels) {
          const fs = Math.round(11 * Math.max(1, sc));
          ctx.font = `${fs}px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace`;
          ctx.textBaseline = 'alphabetic';
          for (const n of N) {
            let a = 0;
            if (n.hub) a = 0.55 + 0.2 * Math.sin(e.t * 1.2 + n.ph) + 0.4 * n.fl;
            else if (n.labT > 0) a = Math.min(1, n.labT) * 0.8;
            if (a < 0.04) continue;
            ctx.fillStyle = rgba(n.hub ? hc : nc, Math.min(1, a));
            ctx.fillText(n.lab, n.x + n.r + 5, n.y - n.r - 3);
          }
        }
      },
    },

    /* ---- 3. Strømning: lysspor, der følger et usynligt strømningsfelt ----
     *  Hvert spor er en kort række punkter. Alle spor tegnes samlet i få streger (fire aldersgrupper
     *  i op til fire farver), så det koster næsten det samme, uanset hvor mange spor der er. */
    flow: {
      q: true,
      init(e) {
        const c = e.cfg;
        const n = Math.round(clamp((e.w * e.h) / 2600, 100, 600) * c.density * e.quality);
        const L = Math.round(clamp(c.flow_trail, 6, 80));
        e.s.L = L;
        e.s.p = Array.from({ length: n }, (_, i) => {
          const p = { g: i % 2, xs: new Float32Array(L), ys: new Float32Array(L), n: 0, head: 0, live: true, life: 0, sp: 1, hx: 1, hy: 0 };
          flowSpawn(e, p);
          p.life = rnd(0.5, 8); // spredt start, så ikke alle løber ud samtidig
          for (let k = 0; k < L; k++) flowStep(e, p, 0.03, 0); // forhåndsfyld sporet
          return p;
        });
        // Fire små lyspunkter (én pr. farve) til hovedernes glød
        e.s.spr = Array.from({ length: 4 }, () => {
          const c2 = document.createElement('canvas');
          c2.width = c2.height = 32;
          return c2;
        });
      },
      draw(e, dt) {
        const { ctx, pal, cfg } = e;
        const s = e.s;
        const L = s.L;
        const wind = cfg.flow_weather ? clamp(e.lv.rain, 0, 1.8) + e.lv.snow * 0.4 : 0;

        for (const p of s.p) {
          if (p.live) {
            p.life -= dt;
            if (p.life <= 0) p.live = false;
            else flowStep(e, p, dt, wind);
          } else if (p.n > 1) p.n--; // sporet løber ud: halen indhenter hovedet
          else flowSpawn(e, p);
        }

        // Farve efter retning: mod højre = første farve, mod venstre = sidste. Ellers skiftes mellem to farver.
        const cols = [mix(pal.p, [255, 255, 255], 0.3), mix(pal.p, pal.s, 0.5), pal.s, pal.a];
        const byDir = cfg.flow_color_dir;
        const cls = (p) => (byDir ? Math.min(3, Math.floor((Math.abs(Math.atan2(p.hy, p.hx)) / Math.PI) * 4)) : p.g ? 3 : 0);
        const wd = cfg.flow_width;
        const widths = [2.2, 1.6, 1.1, 0.7]; // nyeste del er tykkest
        const alphas = [0.85, 0.55, 0.32, 0.16];
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let g = 0; g < 4; g++) {
          for (let b = 0; b < 4; b++) {
            ctx.lineWidth = widths[b] * wd;
            ctx.strokeStyle = rgba(cols[g], alphas[b]);
            ctx.beginPath();
            const k0 = Math.floor((b * L) / 4);
            const k1 = Math.floor(((b + 1) * L) / 4);
            for (const p of s.p) {
              if (p.n < 2 || k0 >= p.n - 1 || cls(p) !== g) continue;
              const top = Math.min(k1, p.n - 1);
              let idx = (p.head - k0 + L) % L;
              ctx.moveTo(p.xs[idx], p.ys[idx]);
              for (let k = k0 + 1; k <= top; k++) {
                idx = (p.head - k + L) % L;
                ctx.lineTo(p.xs[idx], p.ys[idx]);
              }
            }
            ctx.stroke();
          }
        }

        // Lysende hoveder: et lille blødt lys i spidsen af hvert spor
        if (cfg.flow_glow) {
          for (let g = 0; g < 4; g++) {
            const c2 = s.spr[g];
            const sg = c2.getContext('2d');
            sg.clearRect(0, 0, 32, 32);
            const gc = mix(cols[g], [255, 255, 255], 0.2);
            const gr = sg.createRadialGradient(16, 16, 0, 16, 16, 16);
            gr.addColorStop(0, rgba(gc, 1));
            gr.addColorStop(0.3, rgba(gc, 0.5));
            gr.addColorStop(1, rgba(gc, 0));
            sg.fillStyle = gr;
            sg.fillRect(0, 0, 32, 32);
          }
          ctx.globalCompositeOperation = 'lighter';
          const d = 4.5 * wd + 2.5;
          for (const p of s.p) {
            if (p.n < 2) continue;
            ctx.globalAlpha = 0.55 * Math.min(1, p.n / (L * 0.6));
            ctx.drawImage(s.spr[cls(p)], p.xs[p.head] - d, p.ys[p.head] - d, d * 2, d * 2);
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
      },
    },

    /* ---- 4. Matrix: faldende tegn (katakana, runer, binær m.fl.) ----
     * Tegnene forhåndstegnes én gang i et atlas, og hver frame tegnes de med drawImage (hurtigt).
     * Hele laget farves til sidst med "source-in", så farve, regnbue og vejrfarver er næsten gratis. */
    matrix: {
      init(e) {
        const c = e.cfg;
        const chars = matrixChars(c);
        const size = clamp(c.matrix_size, 8, 60) * (e.mobile ? 1.15 : 1); // lidt større tegn på mobil = færre felter
        const dpr = e.mobile ? 1 : e.dpr; // mobil tegner i lavere opløsning (hurtigere)

        // Atlas: ét felt pr. tegn, tegnet i hvidt
        const cell = Math.ceil(size * 1.3 * dpr);
        const per = 16;
        const atlas = document.createElement('canvas');
        atlas.width = per * cell;
        atlas.height = Math.ceil(chars.length / per) * cell;
        const ag = atlas.getContext('2d');
        ag.fillStyle = '#fff';
        ag.textAlign = 'center';
        ag.textBaseline = 'middle';
        ag.font = `${Math.round(size * dpr)}px ${c.matrix_font ? c.matrix_font + ',' : ''}${MATRIX_FONT}`;
        chars.forEach((ch, i) => {
          const cx = (i % per) * cell + cell / 2;
          const cy = Math.floor(i / per) * cell + cell / 2;
          if (c.matrix_mirror) {
            // Spejlvendt, som i filmen
            ag.save();
            ag.translate(cx, cy);
            ag.scale(-1, 1);
            ag.fillText(ch, 0, 0);
            ag.restore();
          } else ag.fillText(ch, cx, cy);
        });

        // Slørede tegn til tegnets glød: samme atlas, tegnet utydeligt (laves én gang)
        const atlasBlur = document.createElement('canvas');
        atlasBlur.width = atlas.width;
        atlasBlur.height = atlas.height;
        const bg2 = atlasBlur.getContext('2d');
        if ('filter' in bg2) {
          bg2.filter = `blur(${Math.max(1.5, size * dpr * 0.14)}px)`;
          bg2.drawImage(atlas, 0, 0);
          bg2.drawImage(atlas, 0, 0);
        } else {
          // Uden filter-støtte: skaleres ned og op igen
          const sm = document.createElement('canvas');
          sm.width = Math.ceil(atlas.width / 3);
          sm.height = Math.ceil(atlas.height / 3);
          sm.getContext('2d').drawImage(atlas, 0, 0, sm.width, sm.height);
          bg2.imageSmoothingEnabled = true;
          bg2.drawImage(sm, 0, 0, atlas.width, atlas.height);
          bg2.drawImage(sm, 0, 0, atlas.width, atlas.height);
        }
        e.s.atlasBlur = atlasBlur;

        const buf = document.createElement('canvas');
        buf.width = Math.max(1, Math.round(e.w * dpr));
        buf.height = Math.max(1, Math.round(e.h * dpr));

        // Dybde: et bageste lag med mindre, langsommere og svagere tegn
        const defs = c.matrix_depth
          ? [
              { k: 0.62, sp: 0.7, al: 0.45 },
              { k: 1, sp: 1, al: 1 },
            ]
          : [{ k: 1, sp: 1, al: 1 }];
        e.s.layers = defs.map(({ k, sp, al }) => {
          const sz = size * k;
          const cw = sz * 0.78;
          const ch = sz * 1.05;
          const cols = Math.ceil(e.w / cw) + 1;
          const rows = Math.ceil(e.h / ch) + 2;
          const g = new Uint16Array(cols * rows);
          for (let i = 0; i < g.length; i++) g[i] = (Math.random() * chars.length) | 0;
          return { k, sp, al, cw, ch, cols, rows, g, col: Array.from({ length: cols }, () => matrixCol(rows, sp, c, true)) };
        });
        e.s.n = chars.length;
        e.s.size = size;
        e.s.cell = cell;
        e.s.atlas = atlas;
        e.s.buf = buf;
        e.s.bg = buf.getContext('2d');
        e.s.dpr = dpr;
        e.s.glow = new Map(); // forhåndstegnede glød-billeder pr. farve
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg, t } = e;
        const s = e.s;
        const dpr = s.dpr;
        const N = s.n;
        const cell = s.cell;
        const mode = cfg.matrix_color;
        const rainbow = mode === 'rainbow';
        const flat = mode === 'palette' ? mix(pal.p, pal.a, 0.3) : [0, 255, 80];

        // Regnbue farves oven på et mellemlager (farven afhænger af placeringen). Alle andre farver
        // farves i selve tegnbilledet, så de kan tegnes direkte uden mellemlager.
        let g = ctx;
        let atlas;
        if (rainbow) {
          g = s.bg;
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalCompositeOperation = 'source-over';
          g.globalAlpha = 1;
          g.clearRect(0, 0, s.buf.width, s.buf.height);
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          atlas = s.atlas;
        } else {
          ctx.save();
          ctx.globalCompositeOperation = 'source-over';
          atlas = matrixTint(s, flat);
        }
        g.imageSmoothingEnabled = true;

        const heads = []; // hvide hovedtegn: x, y, tegn, størrelse, styrke
        const glows = []; // glød: x, y, størrelse, styrke
        const smooth = cfg.matrix_smooth;
        let lastA = -1;
        for (const L of s.layers) {
          const ds = s.size * 1.3 * L.k;
          for (let ci = 0; ci < L.cols; ci++) {
            const c = L.col[ci];
            if (c.wait > 0) {
              c.wait -= dt;
              continue;
            }
            c.head += c.speed * dt;
            if (c.head - c.len > L.rows) {
              Object.assign(c, matrixCol(L.rows, L.sp, cfg, false)); // ny kolonne starter foroven
              continue;
            }
            const hr = Math.floor(c.head);
            if (hr !== c.last) {
              c.last = hr;
              if (hr >= 0 && hr < L.rows) L.g[ci * L.rows + hr] = (Math.random() * N) | 0; // hovedet får et nyt tegn
            }
            const x = ci * L.cw + L.cw / 2;
            const r0 = Math.max(0, Math.ceil(c.head - c.len));
            const r1 = Math.min(hr, L.rows - 1);
            for (let r = r0; r <= r1; r++) {
              const f = 1 - (c.head - r) / c.len; // 1 ved hovedet, 0 yderst i halen
              if (f <= 0) continue;
              let al = f * f * L.al * c.b;
              if (smooth && r === hr) al *= c.head - hr; // det nyeste tegn toner ind, mens hovedet nærmer sig
              if (al < 0.02) continue; // usynlig yderst i halen
              const qa = Math.round(al * 24) / 24; // få alfa-trin giver færre tilstandsskift
              if (qa !== lastA) g.globalAlpha = lastA = qa;
              const gi = L.g[ci * L.rows + r];
              g.drawImage(atlas, (gi % 16) * cell, ((gi / 16) | 0) * cell, cell, cell, x - ds / 2, r * L.ch + L.ch / 2 - ds / 2, ds, ds);
            }
            if (cfg.matrix_head) {
              const a = L.al * c.b;
              if (smooth) {
                // Hovedet glider: det hvide tegn fordeles på de to nærmeste rækker, og gløden følger den præcise position
                const fr = c.head - hr;
                if (hr >= 0 && hr < L.rows) heads.push(x, hr * L.ch + L.ch / 2, L.g[ci * L.rows + hr], ds, a * fr);
                if (hr >= 1 && hr - 1 < L.rows) heads.push(x, (hr - 1) * L.ch + L.ch / 2, L.g[ci * L.rows + hr - 1], ds, a * (1 - fr));
                if (hr >= 0 && hr < L.rows) glows.push(x, (hr + fr) * L.ch, ds, a);
              } else if (hr >= 0 && hr < L.rows) {
                heads.push(x, hr * L.ch + L.ch / 2, L.g[ci * L.rows + hr], ds, a);
                glows.push(x, hr * L.ch + L.ch / 2, ds, a);
              }
            }
          }

          // Tegnene i halen skifter tilfældigt
          let nm = cfg.matrix_mutate * L.cols * 2 * dt;
          nm = Math.floor(nm) + (Math.random() < nm % 1 ? 1 : 0);
          for (let i = 0; i < nm; i++) {
            const ci = (Math.random() * L.cols) | 0;
            const c = L.col[ci];
            if (c.wait > 0) continue;
            const r = clamp(Math.floor(c.head - rnd(0, c.len)), 0, L.rows - 1);
            L.g[ci * L.rows + r] = (Math.random() * N) | 0;
          }
        }

        // Tegnets glød: sløret kopi af hovedets tegn bag det hvide tegn. I regnbue-tilstand tegnes den før farvningen,
        // så den får farven med. De hvide tegn følger det glidende hoved, så gløden følger med.
        const gk = clamp(cfg.matrix_glow, 0, 2);
        const glyphGlow = cfg.matrix_glow_style !== 'round' && gk > 0 && heads.length;
        if (glyphGlow) {
          const sa = rainbow ? s.atlasBlur : matrixTint(s, flat, true);
          for (let i = 0; i < heads.length; i += 5) {
            const gi = heads[i + 2];
            const ds = heads[i + 3];
            g.globalAlpha = Math.min(1, heads[i + 4] * gk * 1.1);
            g.drawImage(sa, (gi % 16) * cell, ((gi / 16) | 0) * cell, cell, cell, heads[i] - ds / 2, heads[i + 1] - ds / 2, ds, ds);
          }
          g.globalAlpha = 1;
        }

        if (rainbow) {
          // Farv alle tegn på én gang
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalAlpha = 1;
          g.globalCompositeOperation = 'source-in';
          const gr = g.createLinearGradient(0, 0, s.buf.width, 0);
          for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, rgba(hslRgb(t * 25 + i * 60, 100, 58), 1));
          g.fillStyle = gr;
          g.fillRect(0, 0, s.buf.width, s.buf.height);
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.globalCompositeOperation = 'source-over';
        }

        // Lyse hoveder: hvidt tegn med en farvet glød omkring (tegnes efter farvningen, så hovedet bliver hvidt)
        if (heads.length) {
          for (let i = 0; i < heads.length; i += 5) {
            const gi = heads[i + 2];
            const ds = heads[i + 3];
            g.globalAlpha = heads[i + 4];
            g.drawImage(s.atlas, (gi % 16) * cell, ((gi / 16) | 0) * cell, cell, cell, heads[i] - ds / 2, heads[i + 1] - ds / 2, ds, ds);
          }
          const gr = gk * 0.85; // 0.85: kalibrerer standard til det tidligere udseende
          if (cfg.matrix_glow_style === 'round' && gr > 0) {
            for (let i = 0; i < glows.length; i += 4) {
              const rgb = rainbow ? hslRgb(t * 25 + (glows[i] / w) * 360, 100, 58) : flat;
              const R = glows[i + 2] * 1.05;
              g.globalAlpha = Math.min(1, glows[i + 3] * gr);
              g.drawImage(matrixGlow(s.glow, rgb), glows[i] - R, glows[i + 1] - R, R * 2, R * 2);
            }
          }
          g.globalAlpha = 1;
        }

        if (rainbow) {
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(s.buf, 0, 0, s.buf.width, s.buf.height, 0, 0, w, h);
        } else {
          ctx.restore();
        }
      },
    },

    /* ---- 5. Retro-gitter: perspektivgitter eller hav mod en horisont med sol (dag) eller måne (nat) ----
     *  Farvevalg: følg paletten, klassisk neon eller Miami (pink og turkis). Valgfri himmel, skyline og hav. */
    retro: {
      init(e) {
        const c = e.cfg;
        const sc = clamp(Math.min(e.w, e.h) / 700, 0.7, 1.5);
        const hor = e.h * clamp(c.retro_horizon, 0.3, 0.8);
        e.s.ph = 0; // gitterets fremdrift (0..1 = én rækkeafstand)
        e.s.cyc = 0; // antal gennemførte rækkeafstande (giver rækkerne en fast identitet)
        e.s.bp = 0; // solens striber glider langsomt nedad
        e.s.sm = e.env.night ? 1 : 0; // 0 = sol, 1 = måne (glider imellem)
        e.s.cx = e.w / 2;
        e.s.sc = sc;
        // Bjergsilhuetter: to lag af skarpe toppe, lavet én gang (værdier 0..1 langs bredden)
        const ridge = () => {
          const p1 = rnd(0, TAU);
          const p2 = rnd(0, TAU);
          const p3 = rnd(0, TAU);
          return Array.from({ length: 160 }, (_, i) => {
            const u = i / 159;
            const v = Math.abs(Math.sin(u * 7 + p1)) * 0.6 + Math.abs(Math.sin(u * 17 + p2)) * 0.3 + Math.abs(Math.sin(u * 41 + p3)) * 0.1;
            const valley = 0.3 + 0.7 * Math.pow(Math.abs(u * 2 - 1), 1.1); // lavere midt for, så solen kan ses
            return v * valley;
          });
        };
        e.s.m = c.retro_skyline === 'mountains' ? [ridge(), ridge()] : null;
        e.s.city = c.retro_skyline === 'city' ? [retroCity(e.w, hor, e.h, 0, sc), retroCity(e.w, hor, e.h, 1, sc)] : null;
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg, t, mouse } = e;
        const s = e.s;
        const hor = h * clamp(cfg.retro_horizon, 0.3, 0.8);
        const FH = h - hor;
        const glow = cfg.retro_glow;
        const mode = cfg.retro_color; // palette | classic | miami
        const classic = mode === 'classic';
        const miami = mode === 'miami';
        const gridCol = miami ? [40, 235, 230] : classic ? [255, 70, 210] : mix(pal.p, [255, 255, 255], 0.25);
        const haloCol = miami ? [255, 70, 170] : classic ? [255, 80, 180] : pal.s;
        const night = s.sm;

        // Forsvindingspunktet følger blidt musen (hvis interaktion er slået til)
        const tx = cfg.interaction && mouse.active ? w / 2 + (mouse.x - w / 2) * 0.15 : w / 2;
        s.cx += (tx - s.cx) * (1 - Math.exp(-dt * 3));
        const cx = s.cx;

        s.ph += dt * cfg.retro_speed * 0.35;
        if (s.ph >= 1) {
          s.ph -= Math.floor(s.ph);
          s.cyc++;
        }
        s.bp = (s.bp + dt * 0.04 * cfg.retro_speed) % 1;
        s.sm += ((e.env.night ? 1 : 0) - s.sm) * (1 - Math.exp(-dt * 0.8));

        // Farvet himmel (valgfri): solnedgang om dagen, mørkere om natten. Dækker baggrunden bag kortet.
        if (cfg.retro_sky) {
          const dim = (c) => mix(c, [8, 4, 28], 0.6 * night);
          const sc0 = miami ? [[48, 22, 110], [215, 58, 150], [255, 150, 90]] : classic ? [[28, 12, 70], [150, 30, 160], [255, 90, 120]] : [mix(pal.bg0, pal.s, 0.15), mix(pal.bg1, pal.s, 0.4), mix(pal.s, pal.a, 0.5)];
          const sg = ctx.createLinearGradient(0, 0, 0, hor);
          sg.addColorStop(0, rgba(dim(sc0[0]), 0.97));
          sg.addColorStop(0.65, rgba(dim(sc0[1]), 0.97));
          sg.addColorStop(1, rgba(dim(sc0[2]), 0.97));
          ctx.fillStyle = sg;
          ctx.fillRect(0, 0, w, hor);
        }

        // Glød langs horisonten
        if (glow > 0) {
          const hg = ctx.createLinearGradient(0, hor - h * 0.14, 0, hor + h * 0.06);
          hg.addColorStop(0, rgba(haloCol, 0));
          hg.addColorStop(0.7, rgba(haloCol, 0.3 * Math.min(1, glow)));
          hg.addColorStop(1, rgba(haloCol, 0));
          ctx.fillStyle = hg;
          ctx.fillRect(0, hor - h * 0.14, w, h * 0.2);
        }

        // Sol eller måne, afskåret ved horisonten
        const R = Math.min(w, h) * 0.19;
        const sy = hor - R * 0.7;
        const sunTop = miami || classic ? (miami ? [255, 215, 120] : [255, 220, 90]) : mix(pal.a, [255, 235, 170], 0.55);
        const sunBot = miami ? [255, 50, 150] : classic ? [255, 40, 150] : mix(pal.s, pal.p, 0.5);
        const moonCol = mix([255, 255, 255], miami ? [255, 190, 235] : pal.a, 0.3);
        if (cfg.retro_sun) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, w, hor);
          ctx.clip();
          const sunA = 1 - s.sm;
          const moonA = s.sm;
          if (sunA > 0.02) {
            const halo = ctx.createRadialGradient(cx, sy, R * 0.6, cx, sy, R * 2.4);
            halo.addColorStop(0, rgba(mix(sunTop, sunBot, 0.5), 0.35 * glow * sunA));
            halo.addColorStop(1, rgba(sunBot, 0));
            ctx.fillStyle = halo;
            ctx.fillRect(cx - R * 2.5, sy - R * 2.5, R * 5, R * 5);
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, sy, R, 0, TAU);
            ctx.clip();
            const sg = ctx.createLinearGradient(0, sy - R, 0, sy + R);
            sg.addColorStop(0, rgba(sunTop, sunA));
            sg.addColorStop(1, rgba(sunBot, sunA));
            ctx.fillStyle = sg;
            // Striber i den nedre halvdel: tykkere jo længere nede, og de glider langsomt nedad
            const S = R * 0.15;
            const bars = [];
            for (let k = 0; k < 14; k++) {
              const yb = sy - R * 0.1 + (k + s.bp) * S;
              if (yb > sy + R) break;
              const fr = (yb - sy) / R;
              bars.push([yb, yb + S * (0.12 + 0.85 * fr)]);
            }
            ctx.beginPath();
            let y0 = sy - R - 2;
            for (const [b0, b1] of bars) {
              if (b0 > y0) ctx.rect(cx - R - 2, y0, R * 2 + 4, b0 - y0);
              y0 = Math.max(y0, b1);
            }
            ctx.rect(cx - R - 2, y0, R * 2 + 4, sy + R + 2 - y0);
            ctx.fill();
            ctx.restore();
          }
          if (moonA > 0.02) {
            const halo = ctx.createRadialGradient(cx, sy, R * 0.7, cx, sy, R * 2.2);
            halo.addColorStop(0, rgba(moonCol, 0.28 * glow * moonA));
            halo.addColorStop(1, rgba(moonCol, 0));
            ctx.fillStyle = halo;
            ctx.fillRect(cx - R * 2.3, sy - R * 2.3, R * 4.6, R * 4.6);
            ctx.fillStyle = rgba(moonCol, 0.92 * moonA);
            ctx.beginPath();
            ctx.arc(cx, sy, R * 0.82, 0, TAU);
            ctx.fill();
            ctx.fillStyle = rgba([0, 0, 0], 0.07 * moonA);
            for (const [ox, oy, rr] of [[-0.25, -0.2, 0.2], [0.3, 0.05, 0.14], [-0.05, 0.35, 0.11]]) {
              ctx.beginPath();
              ctx.arc(cx + ox * R, sy + oy * R, rr * R, 0, TAU);
              ctx.fill();
            }
          }
          ctx.restore();
        }

        // Horisont: bjerge eller skyline. Bageste lag lysere, forreste mørkest, med en svag lysende kant.
        if (s.m) {
          const amps = [0.17, 0.1];
          for (let l = 0; l < 2; l++) {
            const M = s.m[l];
            const base = mix(pal.bg0, pal.s, l === 0 ? 0.22 : 0.06);
            ctx.fillStyle = rgba(base, 0.94);
            ctx.beginPath();
            ctx.moveTo(0, hor + 2);
            for (let i = 0; i < M.length; i++) ctx.lineTo((i / (M.length - 1)) * w, hor - M[i] * amps[l] * h);
            ctx.lineTo(w, hor + 2);
            ctx.closePath();
            ctx.fill();
            if (glow > 0) {
              ctx.strokeStyle = rgba(haloCol, 0.4 * Math.min(1, glow));
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              for (let i = 0; i < M.length; i++) {
                const x = (i / (M.length - 1)) * w;
                const y = hor - M[i] * amps[l] * h;
                if (i) ctx.lineTo(x, y);
                else ctx.moveTo(x, y);
              }
              ctx.stroke();
            }
          }
        }
        if (s.city) {
          for (let l = 0; l < 2; l++) {
            const C = s.city[l];
            ctx.fillStyle = rgba(mix(pal.bg0, [0, 0, 0], l ? 0.5 : 0.2), l ? 0.97 : 0.92);
            ctx.fill(C.fill);
            if (glow > 0) {
              ctx.lineWidth = l ? 1.3 : 1;
              ctx.strokeStyle = rgba(l ? gridCol : haloCol, (l ? 0.75 : 0.5) * Math.min(1, 0.4 + glow * 0.6));
              ctx.stroke(C.edge);
            }
            if (l === 1) {
              ctx.fillStyle = rgba(miami ? [255, 205, 120] : mix(gridCol, [255, 255, 255], 0.5), 0.55);
              ctx.fill(C.win0);
              ctx.fillStyle = rgba(miami ? [255, 205, 120] : mix(gridCol, [255, 255, 255], 0.5), 0.2 + 0.4 * (0.5 + 0.5 * Math.sin(t * 1.7)));
              ctx.fill(C.win1);
            }
          }
        }

        // Gulvet: let mørkere mod forkanten, så gitteret/havet står tydeligt
        const sea = cfg.retro_sea;
        const deep = miami ? [0, 50, 85] : sea ? mix(pal.bg0, pal.s, 0.15) : pal.bg0;
        const fg = ctx.createLinearGradient(0, hor, 0, h);
        fg.addColorStop(0, rgba(deep, sea ? 0.5 : 0.1));
        fg.addColorStop(1, rgba(mix(deep, [0, 0, 0], 0.3), sea ? 0.8 : 0.55));
        ctx.fillStyle = fg;
        ctx.fillRect(0, hor, w, FH);

        const gg = ctx.createLinearGradient(0, hor, 0, h);
        gg.addColorStop(0, rgba(gridCol, 0));
        gg.addColorStop(0.12, rgba(gridCol, sea ? 0.18 : 0.4));
        gg.addColorStop(1, rgba(gridCol, sea ? 0.35 : 0.95));
        ctx.lineCap = 'round';

        if (!sea) {
          // Gitteret: vandrette linjer rykker mod seeren, lodrette løber sammen i forsvindingspunktet
          const NL = Math.round(clamp(cfg.retro_lines, 6, 30));
          const gap = w / Math.max(6, NL * 0.9);
          const M = Math.ceil((w * 0.8) / gap);
          const gridPath = () => {
            ctx.beginPath();
            for (let i = 0; i <= NL; i++) {
              const u = (i + s.ph) / NL;
              if (u > 1) continue;
              const y = hor + FH * Math.pow(u, 2.1);
              ctx.moveTo(0, y);
              ctx.lineTo(w, y);
            }
            for (let j = -M; j <= M; j++) {
              ctx.moveTo(cx, hor);
              ctx.lineTo(cx + j * gap * 1.4, h);
            }
          };
          if (glow > 0) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.22 * Math.min(1, glow);
            ctx.strokeStyle = gg;
            ctx.lineWidth = 4;
            gridPath();
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
          }
          ctx.strokeStyle = gg;
          ctx.lineWidth = 1.2;
          gridPath();
          ctx.stroke();
        } else {
          // Hav: rolige bølgelinjer og solens (eller månens) glimtende spejling
          const NL = Math.round(clamp(cfg.retro_lines, 6, 30)) + 8;
          ctx.strokeStyle = gg;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let i = 0; i <= NL; i++) {
            const u = (i + s.ph) / NL;
            if (u > 1) continue;
            const y = hor + FH * Math.pow(u, 2.1);
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
          }
          ctx.stroke();
          const rc = mix(mix(sunTop, sunBot, 0.35), moonCol, s.sm);
          ctx.fillStyle = rgba(rc, 0.8);
          ctx.beginPath();
          const base = R * 0.5;
          for (let i = 0; i <= NL; i++) {
            const u = (i + s.ph) / NL;
            if (u > 1 || u < 0.02) continue;
            const y = hor + FH * Math.pow(u, 2.1);
            const j = i - s.cyc; // rækkens faste identitet: følger rækken, når den rykker et trin
            for (let m = 0; m < 3; m++) {
              const bw = base * (0.4 + 2.4 * u);
              const off = Math.sin(t * 0.9 + j * 1.7 + m * 2.3) * bw * 0.5;
              const len = bw * (0.3 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.3 + j * 0.9 + m * 1.9)));
              ctx.rect(cx + off - len / 2 + (m - 1) * bw * 0.25, y, len, 1 + 2.6 * u);
            }
          }
          ctx.fill();
          if (glow > 0) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.25 * Math.min(1, glow);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
          }
        }

        // Horisontlinjen
        ctx.strokeStyle = rgba(mix(gridCol, [255, 255, 255], 0.3), 0.85);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(0, hor);
        ctx.lineTo(w, hor);
        ctx.stroke();
      },
    },

    /* ---- 6. Hexagon-net: sekskanter, der lyser op i bølger og krusninger ---- */
    hex: {
      init(e) {
        const R = clamp(e.cfg.hex_size, 16, 160) * (e.mobile ? 1.15 : 1);
        const hw = Math.sqrt(3) * R;
        const vh = 1.5 * R;
        const cols = Math.ceil(e.w / hw) + 2;
        const rows = Math.ceil(e.h / vh) + 2;
        const cx = [];
        const cy = [];
        const ph = [];
        for (let r = -1; r < rows; r++) {
          for (let c = -1; c < cols; c++) {
            cx.push(c * hw + (r & 1 ? hw / 2 : 0));
            cy.push(r * vh);
            ph.push(rnd(0, TAU));
          }
        }
        const vx = [];
        const vy = [];
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 180) * (60 * k - 30);
          vx.push(Math.cos(a));
          vy.push(Math.sin(a));
        }
        const grid = new Path2D();
        for (let i = 0; i < cx.length; i++) {
          for (let k = 0; k < 6; k++) {
            const x = cx[i] + vx[k] * R;
            const y = cy[i] + vy[k] * R;
            if (k === 0) grid.moveTo(x, y);
            else grid.lineTo(x, y);
          }
          grid.closePath();
        }
        e.s.R = R;
        e.s.cx = cx;
        e.s.cy = cy;
        e.s.ph = ph;
        e.s.vx = vx;
        e.s.vy = vy;
        e.s.grid = grid;
        e.s.rip = [];
        e.s.next = rnd(0.5, 2);
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg, t, mouse } = e;
        const s = e.s;
        const R = s.R;

        if (cfg.hex_grid) {
          ctx.lineWidth = 1;
          ctx.strokeStyle = rgba(pal.p, 0.12);
          ctx.stroke(s.grid);
        }

        // Krusninger, der spreder sig ud fra et tilfældigt sted
        if (cfg.hex_ripples) {
          s.next -= dt;
          if (s.next <= 0) {
            s.rip.push({ x: rnd(0, w), y: rnd(0, h), age: 0 });
            s.next = rnd(1.2, 3.5);
            if (s.rip.length > 5) s.rip.shift();
          }
        } else s.rip.length = 0;
        for (const r of s.rip) r.age += dt;
        s.rip = s.rip.filter((r) => r.age < 4.5);

        const useM = cfg.interaction && mouse.active;
        const inset = R * 0.94;
        for (let i = 0; i < s.cx.length; i++) {
          const x = s.cx[i];
          const y = s.cy[i];
          if (x < -R || x > w + R || y < -R || y > h + R) continue;
          let b = 0.05 + 0.04 * Math.sin(t * 0.7 + s.ph[i]);
          if (cfg.hex_waves) {
            const wv = 0.5 + 0.5 * Math.sin((x * 0.7 + y) / (R * 5) - t);
            b += wv * wv * wv * wv * 0.35;
          }
          for (const r of s.rip) {
            const d = Math.hypot(x - r.x, y - r.y);
            const q = (d - r.age * R * 4) / (R * 1.7);
            b += Math.exp(-q * q) * (1 - r.age / 4.5) * 0.9;
          }
          if (useM) {
            const d = Math.hypot(x - mouse.x, y - mouse.y);
            if (d < R * 5) {
              const q = 1 - d / (R * 5);
              b += q * q * 0.9;
            }
          }
          if (b < 0.08) continue;
          b = Math.min(b, 1);
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const px = x + s.vx[k] * inset;
            const py = y + s.vy[k] * inset;
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          if (cfg.hex_fill) {
            ctx.fillStyle = rgba(mix(pal.p, pal.a, b), b * 0.5);
            ctx.fill();
          }
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = rgba(mix(pal.s, pal.a, b), Math.min(1, b * 1.1) * 0.7);
          ctx.stroke();
        }
      },
    },

    /* ---- 7. Aurora: flydende farvebånd ----
     * Bølgerne måles i brøkdele af skærmen (ikke i pixels), så de ser ens ud på en lille
     * forhåndsvisning og på en stor skærm. Der tegnes i lav opløsning og skaleres op. */
    aurora: {
      init(e) {
        const n = clamp(Math.round(e.cfg.aurora_bands), 2, 7);
        e.s.lr = lowRes(e, 4);
        e.s.frame = 0;
        e.s.bands = Array.from({ length: n }, (_, i) => {
          const dir = Math.random() < 0.5 ? -1 : 1;
          return {
            sprite: makeSprite(),
            col: i % 3,
            ph: rnd(0, TAU),
            ph2: rnd(0, TAU),
            c1: rnd(0.6, 1.4), // store bølger på tværs af skærmen
            c2: rnd(1.6, 3.2), // mindre bølger
            sp1: rnd(0.12, 0.28) * dir,
            sp2: rnd(0.2, 0.4) * -dir,
            base: 0.18 + i * (0.42 / n) + rnd(-0.03, 0.03), // placering oppefra (brøkdel af højden)
            amp: rnd(0.05, 0.1), // bølgehøjde (brøkdel af højden)
          };
        });
      },
      draw(e) {
        const { ctx, w, h, pal, cfg, t } = e;
        const s = e.s;
        const { c, g, bw, bh } = s.lr;
        const cols = [pal.s, pal.a, pal.p];
        const k = clamp(cfg.aurora_intensity, 0.1, 2);

        // Farveprøverne males om en gang imellem (paletten glider)
        if (s.frame++ % 10 === 0) {
          for (const b of s.bands) {
            const sg = b.sprite.getContext('2d');
            const gr = sg.createLinearGradient(0, 0, 0, 256);
            const col = cols[b.col];
            gr.addColorStop(0, rgba(col, 0));
            gr.addColorStop(0.5, rgba(col, 0.22 * k));
            gr.addColorStop(0.88, rgba(col, 0.75 * k));
            gr.addColorStop(1, rgba(col, 0));
            sg.clearRect(0, 0, 1, 256);
            sg.fillStyle = gr;
            sg.fillRect(0, 0, 1, 256);
          }
        }

        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
        g.clearRect(0, 0, bw, bh);
        g.globalCompositeOperation = 'lighter';
        const step = 2;
        for (const b of s.bands) {
          const breathe = 0.7 + 0.3 * Math.sin(t * 0.25 + b.ph2); // båndet "ånder" langsomt
          for (let x = 0; x < bw; x += step) {
            const u = x / bw;
            const y0 =
              bh * b.base +
              (Math.sin(u * TAU * b.c1 + t * b.sp1 + b.ph) + 0.5 * Math.sin(u * TAU * b.c2 + t * b.sp2 + b.ph2)) * bh * b.amp;
            const hh = bh * 0.34 * cfg.aurora_height * (0.75 + 0.25 * Math.sin(u * TAU * 1.3 + t * 0.4 + b.ph));
            g.globalAlpha = clamp(breathe * (0.6 + 0.4 * Math.sin(u * TAU * 9 + t * 1.3 + b.ph)), 0, 1); // stråle-flimmer
            g.drawImage(b.sprite, 0, 0, 1, 256, x, y0, step + 0.5, hh);
          }
        }
        g.globalAlpha = 1;

        ctx.globalCompositeOperation = 'lighter';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(c, 0, 0, bw, bh, 0, 0, w, h);
      },
    },

    /* ---- 8. Nordlys-gardiner: lodrette lysgardiner, der bølger ---- */
    curtains: {
      init(e) {
        e.s.lr = lowRes(e, 4);
        e.s.frame = 0;
        const n = clamp(Math.round(e.cfg.curtains_layers), 1, 4);
        e.s.layers = Array.from({ length: n }, (_, i) => ({
          sprite: makeSprite(),
          col: i % 3,
          ph: rnd(0, TAU),
          ph2: rnd(0, TAU),
          sh: rnd(0, TAU),
          c1: rnd(0.5, 1.2),
          c2: rnd(1.5, 2.6),
          sp1: rnd(0.08, 0.2) * (i % 2 ? -1 : 1),
          sp2: rnd(0.12, 0.3),
          top: 0.1 + i * 0.07 + rnd(-0.02, 0.02), // gardinets øverste kant (brøkdel af højden)
          amp: rnd(0.04, 0.08),
        }));
      },
      draw(e) {
        const { ctx, w, h, pal, cfg, t } = e;
        const s = e.s;
        const { c, g, bw, bh } = s.lr;
        const cols = [pal.a, pal.s, pal.p];

        if (s.frame++ % 10 === 0) {
          for (const L of s.layers) {
            const sg = L.sprite.getContext('2d');
            const gr = sg.createLinearGradient(0, 0, 0, 256);
            const col = cols[L.col];
            // Skarp, lys kant foroven, som toner langt ud nedad
            gr.addColorStop(0, rgba(col, 0));
            gr.addColorStop(0.03, rgba(col, 0.85));
            gr.addColorStop(0.18, rgba(col, 0.4));
            gr.addColorStop(0.55, rgba(col, 0.1));
            gr.addColorStop(1, rgba(col, 0));
            sg.clearRect(0, 0, 1, 256);
            sg.fillStyle = gr;
            sg.fillRect(0, 0, 1, 256);
          }
        }

        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
        g.clearRect(0, 0, bw, bh);
        g.globalCompositeOperation = 'lighter';
        const rays = clamp(cfg.curtains_rays, 4, 80);
        const step = e.mobile ? 2 : 1; // mobil tegner grovere (hurtigere)
        for (const L of s.layers) {
          for (let x = 0; x < bw; x += step) {
            const u = x / bw;
            const y0 =
              bh * L.top +
              (Math.sin(u * TAU * L.c1 + t * L.sp1 + L.ph) + 0.5 * Math.sin(u * TAU * L.c2 + t * L.sp2 + L.ph2)) * bh * L.amp;
            // Lodrette stråler, der vandrer langsomt
            const ray = 0.5 + 0.5 * Math.sin(u * TAU * rays + t * 0.6 + L.sh + Math.sin(u * TAU * 2.3 + t * 0.35) * 2.2);
            const len = bh * 0.5 * cfg.curtains_height * (0.55 + 0.45 * Math.sin(u * TAU * 1.7 + t * 0.3 + L.ph2));
            g.globalAlpha = clamp(0.2 + 0.8 * ray * ray, 0, 1);
            g.drawImage(L.sprite, 0, 0, 1, 256, x, y0, step + 0.6, len);
          }
        }
        g.globalAlpha = 1;

        ctx.globalCompositeOperation = 'lighter';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(c, 0, 0, bw, bh, 0, 0, w, h);
      },
    },

    /* ---- 9. Stjernehimmel ---- */
    starfield: {
      q: true,
      init(e) {
        const n = Math.round(clamp((e.w * e.h) / 5000, 60, 300) * e.cfg.density * e.quality);
        e.s.stars = Array.from({ length: n }, () => {
          const z = rnd(0.2, 1);
          return { x: rnd(0, e.w), y: rnd(0, e.h), z, r: z * 1.6 * e.cfg.starfield_size, ph: rnd(0, TAU), tw: rnd(0.5, 2) };
        });
        e.s.ox = 0;
        e.s.oy = 0;
        e.s.next = rnd(3, 8);
        e.s.sh = null;
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg, mouse, t } = e;
        const s = e.s;

        // Parallaks: følger musen, ellers en rolig automatisk svajen
        let tx = 0;
        let ty = 0;
        if (cfg.starfield_parallax) {
          if (cfg.interaction && mouse.active) {
            tx = mouse.x / w - 0.5;
            ty = mouse.y / h - 0.5;
          } else {
            tx = Math.sin(t * 0.05) * 0.3;
            ty = Math.cos(t * 0.04) * 0.2;
          }
        }
        const f = 1 - Math.exp(-dt * 2);
        s.ox += (tx - s.ox) * f;
        s.oy += (ty - s.oy) * f;

        for (const st of s.stars) {
          st.x += st.z * 6 * dt;
          if (st.x > w + 5) st.x = -5;
          const px = st.x - s.ox * st.z * 60;
          const py = st.y - s.oy * st.z * 40;
          const tw = cfg.starfield_twinkle ? 0.5 + 0.5 * Math.sin(t * st.tw + st.ph) : 1;
          const a = tw * (0.4 + 0.6 * st.z);
          if (st.r > 1.4) {
            ctx.fillStyle = rgba(pal.a, a * 0.15);
            ctx.beginPath();
            ctx.arc(px, py, st.r * 3, 0, TAU);
            ctx.fill();
          }
          ctx.fillStyle = rgba(pal.a, a);
          ctx.beginPath();
          ctx.arc(px, py, st.r, 0, TAU);
          ctx.fill();
        }

        // Stjerneskud
        if (cfg.starfield_shooting) {
          s.next -= dt;
          if (s.next <= 0 && !s.sh) {
            const ang = rnd(0.35, 0.6);
            const v = rnd(700, 1000);
            s.sh = {
              x: rnd(w * 0.1, w * 0.9),
              y: rnd(0, h * 0.4),
              vx: Math.cos(ang) * v * (Math.random() < 0.5 ? 1 : -1),
              vy: Math.sin(ang) * v,
              life: 1,
            };
            s.next = rnd(5, 14);
          }
          if (s.sh) {
            const q = s.sh;
            q.x += q.vx * dt;
            q.y += q.vy * dt;
            q.life -= dt * 1.1;
            if (q.life <= 0) {
              s.sh = null;
            } else {
              const tl = 0.12;
              const g = ctx.createLinearGradient(q.x, q.y, q.x - q.vx * tl, q.y - q.vy * tl);
              g.addColorStop(0, rgba(pal.a, q.life));
              g.addColorStop(1, rgba(pal.a, 0));
              ctx.strokeStyle = g;
              ctx.lineWidth = 1.6;
              ctx.beginPath();
              ctx.moveTo(q.x, q.y);
              ctx.lineTo(q.x - q.vx * tl, q.y - q.vy * tl);
              ctx.stroke();
            }
          }
        }
      },
    },

    /* ---- 10. Ildfluer: små, varme lys, der svæver og blinker ---- */
    fireflies: {
      q: true,
      init(e) {
        const n = Math.round(clamp((e.w * e.h) / 30000, 14, 70) * e.cfg.density * e.quality);
        e.s.f = Array.from({ length: n }, () => ({
          x: rnd(0, e.w),
          y: rnd(0, e.h),
          ang: rnd(0, TAU),
          spd: rnd(8, 26),
          turn: rnd(0.8, 2.2),
          ph: rnd(0, TAU),
          fr: rnd(0.25, 0.7), // blink pr. sekund
          r: rnd(1.2, 2.4) * e.cfg.fireflies_size,
          bob: rnd(0, TAU),
        }));
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg, t, mouse } = e;
        const col = cfg.fireflies_color === 'palette' ? pal.p : cfg.fireflies_color === 'amber' ? [255, 190, 80] : [210, 255, 120];
        const useM = cfg.interaction && mouse.active;
        const gl = cfg.fireflies_glow;
        const bl = clamp(cfg.fireflies_blink, 0, 1);
        ctx.globalCompositeOperation = 'lighter';
        for (const f of e.s.f) {
          f.ang += rnd(-1, 1) * f.turn * dt * 3; // flyver i bløde, tilfældige kurver
          f.x += Math.cos(f.ang) * f.spd * dt;
          f.y += (Math.sin(f.ang) * f.spd + Math.sin(t * 0.8 + f.bob) * 4) * dt;
          if (useM) {
            const dx = f.x - mouse.x;
            const dy = f.y - mouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < 14400 && d2 > 1) {
              const d = Math.sqrt(d2);
              f.x += (dx / d) * ((120 - d) / 120) * 70 * dt;
              f.y += (dy / d) * ((120 - d) / 120) * 70 * dt;
            }
          }
          if (f.x < -20) f.x = w + 20;
          else if (f.x > w + 20) f.x = -20;
          if (f.y < -20) f.y = h + 20;
          else if (f.y > h + 20) f.y = -20;

          const sn = Math.sin(t * f.fr * TAU + f.ph);
          const pulse = sn > 0 ? sn * sn : 0;
          const a = (1 - bl) * 0.85 + bl * (0.08 + 0.92 * pulse);
          const R = f.r * 11 * gl;
          const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, R);
          g.addColorStop(0, rgba(col, a));
          g.addColorStop(0.12, rgba(col, a * 0.55));
          g.addColorStop(0.45, rgba(col, a * 0.14));
          g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(f.x, f.y, R, 0, TAU);
          ctx.fill();
          ctx.fillStyle = rgba(mix(col, [255, 255, 255], 0.6), a);
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r * 0.6, 0, TAU);
          ctx.fill();
        }
      },
    },

    /* ---- 11. Støv i lysstråler: lysstråler ind fra toppen med støvkorn, der svæver ----
     *  Strålerne tegnes ikke som vektorformer pr. billede. Én kegle med blød (gaussisk) tværsnitsprofil
     *  males én gang til et lille lærred; hver stråle er derefter blot dette billede, drejet og skaleret.
     *  Det er billigt for grafikkortet og giver bløde kanter uden synlige lag. Støvkornene er ét lille
     *  lyspunkt, som tegnes mange gange. */
    dust: {
      q: true,
      init(e) {
        const c = e.cfg;
        const n = clamp(Math.round(c.dust_beams), 1, 8);
        const base = (c.dust_angle * Math.PI) / 180; // 0 = lige ned, positiv = skråt mod højre
        e.s.ox = e.w * c.dust_origin;
        e.s.oy = -e.h * 0.1;
        e.s.beams = Array.from({ length: n }, (_, i) => ({
          a: base + (n > 1 ? (i / (n - 1) - 0.5) * 0.55 : 0) + rnd(-0.04, 0.04),
          hw: rnd(0.06, 0.13), // halv bredde i radianer
          ph: rnd(0, TAU),
          sp: rnd(0.15, 0.4),
          sw: rnd(0.008, 0.022), // hvor meget strålen svajer (radianer)
          al: 0,
        }));

        // Keglen: lodret midterakse, bredden vokser nedad. Rækker = afstand fra lyskilden, kolonner = tværs.
        const W = 96, H = 192;
        const cone = document.createElement('canvas');
        cone.width = W;
        cone.height = H;
        const cg = cone.getContext('2d');
        const img = cg.createImageData(W, H);
        for (let y = 0; y < H; y++) {
          const yn = y / (H - 1);
          const along = Math.pow(1 - yn, 1.3) * Math.min(1, yn / 0.04); // lysstyrke aftager langs strålen
          const half = Math.max(0.03, yn); // keglens halve bredde ved denne afstand (0..1)
          for (let x = 0; x < W; x++) {
            const u = Math.abs((x + 0.5) / W - 0.5) * 2 / half; // 0 i midten, 1 ved keglens kant
            let v = 0;
            if (u < 1) {
              v = Math.exp(-3.2 * u * u) * (1 - Math.pow(u, 6)) * along; // gauss-profil, der lukker helt mod kanten
            }
            const i = (y * W + x) * 4;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
            img.data[i + 3] = Math.round(255 * clamp(v, 0, 1));
          }
        }
        cg.putImageData(img, 0, 0);
        e.s.cone = cone;
        // Farvet kopi, der opdateres hvert billede (paletten glider langsomt)
        const tint = document.createElement('canvas');
        tint.width = W;
        tint.height = H;
        e.s.tint = tint;
        e.s.tg = tint.getContext('2d');
        // Støvkorn: ét blødt lyspunkt
        const dot = document.createElement('canvas');
        dot.width = dot.height = 24;
        e.s.dot = dot;
        e.s.dg = dot.getContext('2d');
        // Støvkornets skarpe kerne (lille, tydelig prik)
        const core = document.createElement('canvas');
        core.width = core.height = 12;
        e.s.core = core;
        e.s.cg = core.getContext('2d');
        e.s.gt = rnd(2, 6); // tid til næste vindstød
        e.s.gv = 0; // vindstødets styrke (aftager)
        e.s.ga = 0; // vindstødets retning

        const nm = c.dust_motes ? Math.round(clamp((e.w * e.h) / 9000, 40, 200) * c.density * e.quality) : 0;
        e.s.m = Array.from({ length: nm }, () => {
          const z = Math.pow(Math.random(), 2.2); // dybde: mange langt væk (små), få tæt på (store)
          const vx = rnd(-5, 5) * (0.5 + z);
          const vy = rnd(-2, 6) * (0.5 + z);
          return { x: rnd(0, e.w), y: rnd(0, e.h), vx, vy, ux: vx, uy: vy, z, r: 0.55 + 2.2 * z, ph: rnd(0, TAU), tw: rnd(0.5, 1.8) };
        });
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg, t } = e;
        const s = e.s;
        const L = Math.hypot(w, h) * 1.3;
        const col = mix(pal.a, pal.p, 0.25);
        const k = cfg.dust_strength;
        const css = rgba(col, 1);

        // Farv keglen og støvpunktet med den aktuelle palet
        const tg = s.tg;
        tg.globalCompositeOperation = 'source-over';
        tg.clearRect(0, 0, 96, 192);
        tg.drawImage(s.cone, 0, 0);
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = css;
        tg.fillRect(0, 0, 96, 192);
        const cg = s.cg;
        cg.clearRect(0, 0, 12, 12);
        const cr = cg.createRadialGradient(6, 6, 0, 6, 6, 6);
        cr.addColorStop(0, rgba(mix(col, [255, 255, 255], 0.5), 1));
        cr.addColorStop(0.55, rgba(mix(col, [255, 255, 255], 0.3), 0.85));
        cr.addColorStop(1, rgba(col, 0));
        cg.fillStyle = cr;
        cg.fillRect(0, 0, 12, 12);
        const dg = s.dg;
        dg.globalCompositeOperation = 'source-over';
        dg.clearRect(0, 0, 24, 24);
        const gr = dg.createRadialGradient(12, 12, 0, 12, 12, 12);
        gr.addColorStop(0, rgba(col, 1));
        gr.addColorStop(0.35, rgba(col, 0.55));
        gr.addColorStop(1, rgba(col, 0));
        dg.fillStyle = gr;
        dg.fillRect(0, 0, 24, 24);

        ctx.globalCompositeOperation = 'lighter';

        // Strålerne: ét billede pr. stråle, drejet efter retningen og strukket til længde og bredde
        for (const b of s.beams) {
          b.al = clamp(k * 0.36 * (0.6 + 0.4 * Math.sin(t * b.sp + b.ph)), 0, 1);
          const a = b.a + Math.sin(t * b.sp * 0.7 + b.ph * 2) * b.sw;
          ctx.save();
          ctx.translate(s.ox, s.oy);
          ctx.rotate(-a);
          ctx.scale((L * Math.tan(b.hw) * 1.3) / 48, L / 192); // 48 = halv bredde af keglebilledet
          ctx.globalAlpha = b.al;
          ctx.drawImage(s.tint, -48, 0);
          ctx.restore();
        }
        ctx.globalAlpha = 1;

        // Vind: en rolig grundvind, der skifter retning, og enkelte vindstød, der klinger af
        const wk = cfg.dust_wind;
        let wx = 0;
        let wy = 0;
        if (wk > 0) {
          s.gt -= dt;
          if (s.gt <= 0) {
            s.gt = rnd(8, 20);
            s.gv = rnd(0.8, 1.6);
            s.ga = rnd(-0.6, 0.6) + (Math.random() < 0.5 ? 0 : Math.PI);
          }
          s.gv *= Math.exp(-dt * 0.45);
          wx = wk * ((Math.sin(t * 0.17) + 0.6 * Math.sin(t * 0.53 + 1)) * 7 + Math.cos(s.ga) * s.gv * 55 + e.lv.rain * 9);
          wy = wk * (Math.sin(t * 0.23 + 2) * 3 + Math.sin(s.ga) * s.gv * 22);
        }
        const useM = cfg.interaction && e.mouse.active;
        const fk = 0.0035; // størrelsen på hvirvlerne
        const fsc = (26 * wk) / (fk * 1.6);
        const mix2 = 1 - Math.exp(-dt * 1.6); // hvor hurtigt støvet følger vinden

        // Støvkorn: små skarpe prikker. De lyser og glimter, når de er inde i en stråle.
        for (const m of s.m) {
          let tvx = m.vx;
          let tvy = m.vy;
          if (wk > 0) {
            // Hvirvler: strømningen er "krøllen" af en strømfunktion, så støvet kredser i stedet for at samle sig
            const gx = (flowPsi(m.x + 3, m.y, fk, t) - flowPsi(m.x - 3, m.y, fk, t)) / 6;
            const gy = (flowPsi(m.x, m.y + 3, fk, t) - flowPsi(m.x, m.y - 3, fk, t)) / 6;
            const dz = 0.5 + m.z;
            tvx += gy * fsc * dz + wx * (0.4 + 0.8 * m.z);
            tvy += -gx * fsc * dz + wy * (0.4 + 0.8 * m.z);
          }
          if (useM) {
            const dx = m.x - e.mouse.x;
            const dy = m.y - e.mouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < 19600 && d2 > 1) {
              const d = Math.sqrt(d2);
              const f = 1 - d / 140;
              tvx += (dx / d) * f * 70 - (dy / d) * f * 50; // skubbes væk og drejer let rundt om markøren
              tvy += (dy / d) * f * 70 + (dx / d) * f * 50;
            }
          }
          m.ux += (tvx - m.ux) * mix2;
          m.uy += (tvy - m.uy) * mix2;
          m.x += (m.ux + Math.sin(t * 0.4 + m.ph) * 3) * dt;
          m.y += (m.uy + Math.cos(t * 0.3 + m.ph) * 2) * dt;
          if (m.x < -5) m.x = w + 5;
          else if (m.x > w + 5) m.x = -5;
          if (m.y < -5) m.y = h + 5;
          else if (m.y > h + 5) m.y = -5;
          const ang = Math.atan2(m.x - s.ox, m.y - s.oy);
          let lit = 0;
          for (const b of s.beams) {
            const d = Math.abs(ang - b.a);
            if (d < b.hw) lit = Math.max(lit, (1 - d / b.hw) * Math.min(1, b.al * 6));
          }
          const tw = 0.6 + 0.4 * Math.sin(t * m.tw + m.ph);
          const glint = Math.pow(Math.max(0, Math.sin(t * m.tw * 2.7 + m.ph * 3)), 10) * lit; // kort glimt i strålen
          const al = (0.16 + 0.84 * lit) * tw * (0.55 + 0.45 * Math.min(1, m.z * 2.5)) * (1 + 1.2 * glint);
          // Blød glød under de store eller oplyste korn, derefter den skarpe kerne
          if (m.r > 1 || lit > 0.1) {
            const dh = m.r * (m.z > 0.6 ? 6 : 4);
            ctx.globalAlpha = Math.min(1, al * 0.45 * (0.4 + lit));
            ctx.drawImage(s.dot, m.x - dh, m.y - dh, dh * 2, dh * 2);
          }
          const dc = m.r * 1.5 + 0.8;
          ctx.globalAlpha = Math.min(1, al * (m.z > 0.6 ? 1 : 1.4));
          ctx.drawImage(s.core, m.x - dc, m.y - dc, dc * 2, dc * 2);
        }
        ctx.globalAlpha = 1;
      },
    },

    /* ---- 12. Bokeh: bløde, svævende lysbobler ---- */
    bokeh: {
      q: true,
      init(e) {
        const n = Math.round(clamp((e.w * e.h) / 60000, 8, 34) * e.cfg.density * e.quality);
        const scale = clamp(Math.min(e.w, e.h) / 900, 0.6, 1.4);
        e.s.orbs = Array.from({ length: n }, (_, i) => ({
          x: rnd(0, e.w),
          y: rnd(0, e.h),
          r: rnd(30, 110) * e.cfg.bokeh_size * scale,
          vx: rnd(-8, 8),
          vy: rnd(-10, -2),
          ph: rnd(0, TAU),
          c: i % 3,
          a: rnd(0.08, 0.22),
        }));
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg } = e;
        const cols = [pal.p, pal.s, pal.a];
        const inner = clamp(1 - cfg.bokeh_soft, 0.05, 0.95);
        ctx.globalCompositeOperation = 'lighter';
        for (const o of e.s.orbs) {
          o.x += o.vx * dt;
          o.y += o.vy * dt;
          if (o.y < -o.r) {
            o.y = h + o.r;
            o.x = rnd(0, w);
          }
          if (o.x < -o.r) o.x = w + o.r;
          else if (o.x > w + o.r) o.x = -o.r;
          const a = o.a * (0.7 + 0.3 * Math.sin(e.t * 0.6 + o.ph));
          const col = cols[o.c];
          const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
          g.addColorStop(0, rgba(col, a * 0.4));
          g.addColorStop(inner, rgba(col, a * 0.65));
          g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(o.x, o.y, o.r, 0, TAU);
          ctx.fill();
        }
      },
    },

    /* ---- 13. Lavalampe: tykke klatter, der smelter sammen og skilles ----
     * Klatternes felt beregnes pixel for pixel i lav opløsning (metaballs) og skaleres op. */
    lava: {
      init(e) {
        const bw = clamp(Math.round(e.w / (e.mobile ? 6 : 3.5)), 100, 560);
        const bh = Math.max(60, Math.round((bw * e.h) / e.w));
        const c = document.createElement('canvas');
        c.width = bw;
        c.height = bh;
        const g = c.getContext('2d');
        const img = g.createImageData(bw, bh);
        const n = clamp(Math.round(e.cfg.lava_blobs * e.cfg.density), 3, 12);
        e.s.c = c;
        e.s.g = g;
        e.s.img = img;
        e.s.u32 = new Uint32Array(img.data.buffer);
        e.s.bw = bw;
        e.s.bh = bh;
        e.s.bl = Array.from({ length: n }, () => ({
          r: rnd(0.07, 0.14) * e.cfg.lava_size, // radius som brøkdel af højden
          px: rnd(0, TAU),
          py: rnd(0, TAU),
          sx: rnd(0.08, 0.18),
          sy: rnd(0.1, 0.24),
          ax: rnd(0.25, 0.42),
        }));
        e.s.bx = new Float32Array(n);
        e.s.by = new Float32Array(n);
        e.s.br2 = new Float32Array(n);
      },
      draw(e) {
        const { ctx, w, h, pal, cfg, t } = e;
        const s = e.s;
        const { bw, bh, u32, bl, bx, by, br2 } = s;
        const n = bl.length;
        for (let i = 0; i < n; i++) {
          bx[i] = (0.5 + bl[i].ax * Math.sin(t * bl[i].sx + bl[i].px)) * bw;
          by[i] = (0.5 + 0.42 * Math.sin(t * bl[i].sy + bl[i].py)) * bh;
          br2[i] = Math.pow(bl[i].r * bh, 2);
        }
        const soft = clamp(cfg.lava_soft, 0.03, 1) * 0.5;
        const c0 = pal.s;
        const c1 = pal.p;
        const ca = pal.a;
        const glow = cfg.lava_glow ? 0.5 : 0;
        for (let y = 0; y < bh; y++) {
          const k = y / bh;
          const rr = lerp(c0[0], c1[0], k);
          const gg = lerp(c0[1], c1[1], k);
          const bb = lerp(c0[2], c1[2], k);
          for (let x = 0; x < bw; x++) {
            let f = 0;
            for (let i = 0; i < n; i++) {
              const dx = x - bx[i];
              const dy = y - by[i];
              f += br2[i] / (dx * dx + dy * dy + 1);
            }
            const a = smoothstep(1 - soft, 1 + soft, f);
            if (a <= 0.002) {
              u32[y * bw + x] = 0;
              continue;
            }
            const gl = glow * clamp((f - 1) / 3, 0, 1); // lysere midte
            const R = Math.min(255, rr + (ca[0] - rr) * gl);
            const G = Math.min(255, gg + (ca[1] - gg) * gl);
            const B = Math.min(255, bb + (ca[2] - bb) * gl);
            u32[y * bw + x] = (((a * 255) | 0) << 24) | ((B | 0) << 16) | ((G | 0) << 8) | (R | 0);
          }
        }
        s.g.putImageData(s.img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(s.c, 0, 0, bw, bh, 0, 0, w, h);
      },
    },

    /* ---- 14. Flydende gradient (billigst for ydelsen) ---- */
    gradient: {
      init(e) {
        const n = clamp(Math.round(e.cfg.gradient_blobs * e.cfg.density), 2, 10);
        const m = Math.max(e.w, e.h);
        e.s.blobs = Array.from({ length: n }, (_, i) => ({
          ph1: rnd(0, TAU),
          ph2: rnd(0, TAU),
          sx: rnd(0.08, 0.2),
          sy: rnd(0.08, 0.2),
          r: rnd(0.3, 0.55) * m * e.cfg.gradient_size,
          c: i % 3,
        }));
      },
      draw(e) {
        const { ctx, w, h, pal, t } = e;
        const cols = [pal.p, pal.s, pal.a];
        ctx.globalCompositeOperation = 'screen';
        for (const b of e.s.blobs) {
          const x = w * (0.5 + 0.38 * Math.sin(t * b.sx + b.ph1));
          const y = h * (0.5 + 0.38 * Math.cos(t * b.sy + b.ph2));
          ctx.fillStyle = softRadial(ctx, x, y, b.r, cols[b.c], 0.38);
          ctx.fillRect(x - b.r, y - b.r, b.r * 2, b.r * 2);
        }
      },
    },

    /* ---- 15. Bølger: lag af bløde bølger som et hav ---- */
    waves: {
      init(e) {
        const n = clamp(Math.round(e.cfg.waves_layers), 2, 8);
        e.s.L = Array.from({ length: n }, (_, i) => ({
          ph: rnd(0, TAU),
          ph2: rnd(0, TAU),
          f1: rnd(0.7, 1.4) + i * 0.12,
          f2: rnd(2, 3.4),
          sp1: rnd(0.25, 0.5) * (i % 2 ? -1 : 1),
          sp2: rnd(0.35, 0.7),
          base: 0.46 + (i / (n - 1)) * 0.46, // 0.46 (bagerst) til 0.92 (forrest), brøkdel af højden
          amp: 0.012 + (i / (n - 1)) * 0.016,
        }));
      },
      draw(e) {
        const { ctx, w, h, pal, cfg, t } = e;
        const L = e.s.L;
        const n = L.length;

        // Glød ved horisonten
        if (cfg.waves_glow) {
          const g = ctx.createLinearGradient(0, h * 0.25, 0, h * 0.75);
          g.addColorStop(0, rgba(pal.a, 0));
          g.addColorStop(0.55, rgba(pal.a, 0.16));
          g.addColorStop(1, rgba(pal.a, 0));
          ctx.fillStyle = g;
          ctx.fillRect(0, h * 0.25, w, h * 0.5);
        }

        const step = Math.max(4, Math.round(w / 180));
        const pts = Math.ceil(w / step) + 1;
        const ys = new Float32Array(pts);
        for (let i = 0; i < n; i++) {
          const b = L[i];
          const k = i / (n - 1);
          const col = mix(pal.p, pal.s, k);
          for (let j = 0; j < pts; j++) {
            const u = (j * step) / w;
            ys[j] =
              h * b.base +
              (Math.sin(u * TAU * b.f1 + t * b.sp1 + b.ph) + 0.4 * Math.sin(u * TAU * b.f2 + t * b.sp2 + b.ph2)) *
                h *
                b.amp *
                cfg.waves_height;
          }
          // Selve bølgelaget
          const a = 0.2 + 0.3 * k;
          const g = ctx.createLinearGradient(0, h * b.base - h * 0.05, 0, h);
          g.addColorStop(0, rgba(col, a));
          g.addColorStop(1, rgba(col, a * 0.35));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(0, h);
          for (let j = 0; j < pts; j++) ctx.lineTo(j * step, ys[j]);
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.fill();
          // Lys skumkant
          if (cfg.waves_foam) {
            ctx.strokeStyle = rgba(pal.a, 0.14 + 0.2 * k);
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(0, ys[0]);
            for (let j = 1; j < pts; j++) ctx.lineTo(j * step, ys[j]);
            ctx.stroke();
          }
        }
      },
    },

    /* ---- 16. Regnvindue: dråber, der samler sig og løber ned ad ruden ---- */
    rainwindow: {
      q: true,
      init(e) {
        const c = e.cfg;
        const n = Math.round(clamp((e.w * e.h) / 4500, 40, 320) * c.density * e.quality * (c.rainwindow_natural ? 1.4 : 1));
        e.s.st = Array.from({ length: n }, () => rwDrop(e, true)); // dråber, der sidder stille
        e.s.cap = Math.round(n * 1.3); // loft, når store dråber efterlader små
        e.s.sl = []; // dråber, der glider
        const scale = clamp(Math.min(e.w, e.h) / 900, 0.6, 1.4);
        const nl = c.rainwindow_lights ? Math.round(clamp((e.w * e.h) / 90000, 5, 16) * e.quality) : 0;
        e.s.lights = Array.from({ length: nl }, (_, i) => ({
          x: rnd(0, e.w),
          y: rnd(0, e.h * 0.9),
          r: rnd(30, 90) * scale,
          ph: rnd(0, TAU),
          c: i % 3,
          vx: rnd(-4, 4),
        }));
      },
      draw(e, dt) {
        const { ctx, w, h, pal, cfg, t } = e;
        const s = e.s;
        const sz = cfg.rainwindow_size;

        // Lys bag ruden (som byens lys i regnvejr)
        if (s.lights.length) {
          const cols = [pal.p, pal.s, pal.a];
          ctx.globalCompositeOperation = 'lighter';
          for (const o of s.lights) {
            o.x += o.vx * dt;
            if (o.x < -o.r) o.x = w + o.r;
            else if (o.x > w + o.r) o.x = -o.r;
            const a = 0.1 + 0.08 * Math.sin(t * 0.5 + o.ph);
            const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
            g.addColorStop(0, rgba(cols[o.c], a * 1.2));
            g.addColorStop(0.6, rgba(cols[o.c], a));
            g.addColorStop(1, rgba(cols[o.c], 0));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(o.x, o.y, o.r, 0, TAU);
            ctx.fill();
          }
          ctx.globalCompositeOperation = 'source-over';
        }

        // Stille dråber vokser. Store (eller tilfældige) begynder at glide.
        const rate = cfg.rainwindow_rate;
        for (let i = 0; i < s.st.length; i++) {
          const d = s.st[i];
          d.r += 0.25 * sz * dt;
          if (d.r > d.thr || (d.r > 3 * sz && Math.random() < 0.02 * rate * dt)) {
            s.sl.push({
              x: d.x,
              y: d.y,
              r: d.r,
              v: 0,
              vmax: rnd(70, 150) * (0.5 + d.r / (6 * sz)) * d.vm,
              gl: d.gl,
              sat: 0,
              moving: true,
              timer: rnd(0.4, 1.4),
              ph: rnd(0, TAU),
              last: d.y,
              tr: [{ x: d.x, y: d.y }],
            });
            s.st[i] = rwDrop(e, false);
          }
        }

        // Glidende dråber: går i stå og kører igen, samler små dråber op og efterlader et spor
        for (let i = s.sl.length - 1; i >= 0; i--) {
          const d = s.sl[i];
          d.timer -= dt;
          if (d.timer <= 0) {
            d.moving = !d.moving;
            d.timer = d.moving ? rnd(0.3, 1.2) : rnd(0.15, 0.8);
          }
          d.v += ((d.moving ? d.vmax : 0) - d.v) * (1 - Math.exp(-dt * 4));
          d.y += d.v * dt;
          d.x += Math.sin(d.y * 0.05 + d.ph) * 4 * dt;
          if (cfg.rainwindow_natural && d.r > 2.2 * sz) {
            // Små dråber bliver siddende bag den glidende
            d.sat += d.v * dt;
            if (d.sat > rnd(14, 34) * sz) {
              d.sat = 0;
              d.r *= 0.985;
              s.st.push({ x: d.x + rnd(-0.7, 0.7) * d.r, y: d.y - d.r * rnd(0.6, 1.4), r: rnd(0.5, 1.1) * sz, thr: rnd(6, 11) * sz, gl: rnd(0.6, 1.3), vm: rnd(0.7, 1.3) });
              if (s.st.length > s.cap) s.st.shift();
            }
          }
          d.r = Math.max(0, d.r - 0.35 * sz * dt * (d.v / 100)); // mister lidt vand undervejs
          if (cfg.rainwindow_trails && d.y - d.last > 3) {
            d.tr.push({ x: d.x, y: d.y });
            d.last = d.y;
            if (d.tr.length > 45) d.tr.shift();
          }
          for (let j = 0; j < s.st.length; j++) {
            const o = s.st[j];
            const dx = o.x - d.x;
            const dy = o.y - d.y;
            const rr = o.r + d.r;
            if (dx * dx + dy * dy < rr * rr * 0.8) {
              d.r = Math.sqrt(d.r * d.r + o.r * o.r * 0.6);
              d.vmax *= 1.08;
              s.st[j] = rwDrop(e, false);
            }
          }
          if (d.y > h + 10 || d.r < 1.2 * sz) s.sl.splice(i, 1);
        }

        // Spor
        if (cfg.rainwindow_trails) {
          ctx.lineCap = 'round';
          for (const d of s.sl) {
            const n = d.tr.length;
            if (n < 2) continue;
            ctx.lineWidth = Math.max(1, d.r * 0.5);
            for (let k = 0; k < 3; k++) {
              const a = Math.floor((n * k) / 3);
              const b = Math.min(n - 1, Math.floor((n * (k + 1)) / 3) + 1);
              ctx.strokeStyle = rgba(pal.a, 0.03 + 0.05 * k);
              ctx.beginPath();
              ctx.moveTo(d.tr[a].x, d.tr[a].y);
              for (let m = a + 1; m <= b; m++) ctx.lineTo(d.tr[m].x, d.tr[m].y);
              ctx.stroke();
            }
          }
        }

        // Dråberne selv: krop, kant og et lille lysglimt
        ctx.beginPath();
        for (const d of s.st) {
          ctx.moveTo(d.x + d.r, d.y);
          ctx.arc(d.x, d.y, d.r, 0, TAU);
        }
        for (const d of s.sl) {
          if (cfg.rainwindow_natural) {
            // Dråbeform: rund forneden, med en spids hale opad, som vokser med farten
            const rx = d.r * 0.85;
            const cy = d.y + d.r * 0.2;
            const tail = d.r * (0.35 + 1.5 * clamp(d.v / 120, 0, 1));
            ctx.moveTo(d.x + rx, cy);
            ctx.arc(d.x, cy, rx, 0, Math.PI);
            ctx.quadraticCurveTo(d.x - rx * 0.4, cy - tail * 0.6, d.x, cy - tail);
            ctx.quadraticCurveTo(d.x + rx * 0.4, cy - tail * 0.6, d.x + rx, cy);
          } else {
            ctx.moveTo(d.x + d.r * 0.85, d.y);
            ctx.ellipse(d.x, d.y, d.r * 0.85, d.r * 1.2, 0, 0, TAU);
          }
        }
        ctx.fillStyle = rgba(pal.a, 0.1);
        ctx.fill();
        ctx.strokeStyle = rgba(pal.a, 0.3);
        ctx.lineWidth = 0.9;
        ctx.stroke();

        ctx.beginPath();
        for (const d of s.st) {
          ctx.moveTo(d.x - d.r * 0.05, d.y - d.r * 0.4);
          ctx.arc(d.x - d.r * 0.35, d.y - d.r * 0.4, d.r * 0.3 * d.gl, 0, TAU);
        }
        for (const d of s.sl) {
          ctx.moveTo(d.x - d.r * 0.05, d.y - d.r * 0.5);
          ctx.arc(d.x - d.r * 0.3, d.y - d.r * 0.5, d.r * 0.28 * (d.gl || 1), 0, TAU);
        }
        ctx.fillStyle = rgba([255, 255, 255], 0.55);
        ctx.fill();
      },
    },
  };

  /* ======================================================================
   * 6. Bg - MONTERER CANVAS BAG DASHBOARDET
   *    Canvas'et lægges inde i <hui-root> (dashboardets ramme), bag kortene.
   *    Samtidig gøres dashboardets egen baggrund gennemsigtig.
   *    Der findes kun ét baggrunds-canvas ad gangen.
   * ==================================================================== */
  const Bg = {
    engine: null,
    canvas: null,
    root: null,
    styleEl: null,
    layer: null, // baggrundslag (tema/billede/video) under canvas'et
    media: null,
    dim: null,
    video: null,
    _bgKey: '',
    owner: null,
    owners: new Set(),
    timer: null,
    _m: '',

    claim(card, root) {
      clearTimeout(this.timer);
      this.owners.add(card);
      this.owner = card;
      if (!this._mount(root)) return false;
      this.engine.setConfig(card._config);
      this.engine.env = card._env;
      this.applyBackground(card._config);
      return true;
    },

    release(card) {
      this.owners.delete(card);
      if (this.owner === card) this.owner = [...this.owners].pop() || null;
      if (this.owners.size === 0) {
        clearTimeout(this.timer);
        // Lille forsinkelse, så skift mellem views ikke får baggrunden til at blinke
        this.timer = setTimeout(() => this._unmount(), 500);
      }
    },

    _mount(root) {
      if (this.root === root && this.canvas && this.canvas.isConnected) return true;
      this._unmount();
      const sr = root.shadowRoot;
      if (!sr) return false;
      this.root = root;
      this.canvas = document.createElement('canvas');
      this.canvas.id = 'ambient-backdrop-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
      Object.assign(this.canvas.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '-1',
        left: '0',
        top: '0',
        width: '100vw',
        height: '100vh',
      });
      // Baggrundslag (tema/billede/video) lige under canvas'et.
      // Opbygning: layer > media (billede/video) + dim (mørkt lag oven på)
      this.layer = document.createElement('div');
      this.layer.id = 'ambient-backdrop-layer';
      this.layer.setAttribute('aria-hidden', 'true');
      Object.assign(this.layer.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '-2',
        overflow: 'hidden',
        left: '0',
        top: '0',
        width: '100vw',
        height: '100vh',
        display: 'none',
      });
      this.media = document.createElement('div');
      Object.assign(this.media.style, { position: 'absolute', inset: '0' });
      this.dim = document.createElement('div');
      Object.assign(this.dim.style, { position: 'absolute', inset: '0' });
      this.layer.append(this.media, this.dim);
      this._bgKey = '';

      this.styleEl = document.createElement('style');
      this.styleEl.id = 'ambient-backdrop-style';
      // isolation: samler dashboardets lag, så z-index:-1 lander lige bag kortene
      this.styleEl.textContent =
        ':host{isolation:isolate;--lovelace-background:transparent !important;}' +
        '#view,hui-view{background:transparent !important;}';
      sr.prepend(this.styleEl, this.layer, this.canvas);

      // Videoen pauses, når fanen er skjult (sparer batteri), og startes igen bagefter.
      // Første tryk på siden starter den, hvis browseren har blokeret autoplay.
      this._onVis = () => {
        if (!this.video) return;
        if (document.hidden) this.video.pause();
        else this.video.play().catch(() => {});
      };
      this._onPtr = () => {
        if (this.video && this.video.paused && !document.hidden) this.video.play().catch(() => {});
      };
      document.addEventListener('visibilitychange', this._onVis);
      window.addEventListener('pointerdown', this._onPtr, { passive: true });
      this._m = '';
      this.engine = new Engine(this.canvas, () => this._measure());
      this.engine.start();
      return true;
    },

    // Canvas'et dækker kun dashboard-området (ikke sidebaren)
    _measure() {
      const r = this.root.getBoundingClientRect();
      const left = Math.max(r.left, 0);
      const top = Math.max(r.top, 0);
      const w = Math.min(r.right, window.innerWidth) - left;
      const h = Math.min(r.bottom, window.innerHeight) - top;
      const vals = [left, top, w, h].map((v) => Math.round(v) + 'px');
      const key = vals.join();
      if (key !== this._m) {
        // Canvas og baggrundslag følger samme område
        for (const el of [this.canvas, this.layer]) {
          const st = el.style;
          st.left = vals[0];
          st.top = vals[1];
          st.width = vals[2];
          st.height = vals[3];
        }
        this._m = key;
      }
      return { w, h };
    },

    // Temaets egen baggrund (billede eller farve). Læses fra roden, hvor HA lægger tema-variablerne.
    _themeBg() {
      const cs = getComputedStyle(document.documentElement);
      return (
        cs.getPropertyValue('--lovelace-background').trim() ||
        cs.getPropertyValue('--primary-background-color').trim() ||
        '#111'
      );
    },

    // Opdaterer baggrundslaget. Gør kun noget, når indstillingerne (eller temaet) er ændret.
    applyBackground(cfg) {
      if (!this.layer) return;
      const src = cfg.background_source;
      const themeVal = src === 'theme' ? this._themeBg() : '';
      const dimV = clamp(Number(cfg.background_dim) || 0, 0, 0.95);
      const blur = clamp(Number(cfg.background_blur) || 0, 0, 40);
      const speed = clamp(Number(cfg.background_video_speed) || 1, 0.1, 4);
      const key = [src, cfg.background_image, cfg.background_video, dimV, blur, speed, themeVal].join('|');
      if (key === this._bgKey) return;
      this._bgKey = key;

      const M = this.media;
      // Ryd det gamle
      if (this.video) {
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
        this.video = null;
      }
      M.replaceChildren();
      M.style.background = '';

      this.layer.style.display = src === 'none' ? 'none' : 'block';
      this.dim.style.background = `rgba(0,0,0,${dimV})`;
      // Sløring: laget forstørres lidt, så de udtværede kanter ligger uden for skærmen
      M.style.filter = blur > 0 ? `blur(${blur}px)` : '';
      M.style.transform = blur > 0 ? 'scale(1.1)' : '';

      if (src === 'theme') {
        M.style.background = themeVal;
      } else if (src === 'image' && cfg.background_image) {
        M.style.background = `center / cover no-repeat url("${cssUrl(cfg.background_image)}")`;
      } else if (src === 'video' && cfg.background_video) {
        const v = document.createElement('video');
        v.muted = true; // lydløs, ellers blokerer browseren autoplay
        v.defaultMuted = true;
        v.loop = true; // loop
        v.autoplay = true;
        v.playsInline = true; // nødvendigt på iOS/mobil
        v.preload = 'auto';
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
        v.src = cfg.background_video;
        v.addEventListener('loadedmetadata', () => (v.playbackRate = speed));
        // Sikkerhedsnet: nogle enheder stopper ved enden trods loop
        v.addEventListener('ended', () => {
          v.currentTime = 0;
          v.play().catch(() => {});
        });
        M.appendChild(v);
        this.video = v;
        v.playbackRate = speed;
        v.play().catch(() => {});
      }
    },

    _unmount() {
      document.removeEventListener('visibilitychange', this._onVis);
      window.removeEventListener('pointerdown', this._onPtr);
      if (this.engine) this.engine.stop();
      if (this.video) {
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
        this.video = null;
      }
      if (this.layer) this.layer.remove();
      if (this.canvas) this.canvas.remove();
      if (this.styleEl) this.styleEl.remove();
      this.engine = this.canvas = this.styleEl = this.root = null;
      this.layer = this.media = this.dim = null;
      this._bgKey = '';
    },
  };

  /* ======================================================================
   * 7. KORTET
   *    Uden for redigering er kortet skjult. I redigeringstilstand viser det
   *    en lille statuslinje. I editorens forhåndsvisning vises en mini-animation.
   * ==================================================================== */
  class AmbientBackdropCard extends HTMLElement {
    constructor() {
      super();
      this._config = { ...DEFAULTS };
      this._env = { cat: 'clear', night: true };
      this._connected = false;
    }

    static getConfigElement() {
      return document.createElement('ambient-backdrop-card-editor');
    }

    static getStubConfig(hass) {
      const w = hass && Object.keys(hass.states || {}).find((k) => k.startsWith('weather.'));
      return { style: 'particles', weather_entity: w || '' };
    }

    setConfig(config) {
      if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
      this._config = { ...DEFAULTS, ...config };
      if (!STYLES[this._config.style]) this._config.style = 'particles';
      this._buildDom();
      this._envSig = null;
      this._updateEnv();
      this._sync();
    }

    set hass(hass) {
      const c = this._config;
      const st = (hass && hass.states) || {};
      const sig = c ? [st[c.weather_entity], st[c.sun_entity]].map((x) => x && x.state).join('|') : '';
      this._hass = hass;
      if (sig === this._envSig) return; // hverken vejr eller sol er ændret
      this._envSig = sig;
      this._updateEnv();
    }

    getCardSize() {
      return 1;
    }

    getGridOptions() {
      return { columns: 'full', rows: 'auto', min_columns: 3 };
    }

    connectedCallback() {
      this._connected = true;
      this._buildDom();
      this._sync();
      // Tjekker jævnligt, om dashboardet er i redigeringstilstand
      this._poll = setInterval(() => this._sync(true), 1000);
    }

    disconnectedCallback() {
      this._connected = false;
      clearInterval(this._poll);
      Bg.release(this);
      if (this._preview) {
        this._preview.stop();
        this._preview = null;
      }
    }

    // Finder dashboardets ramme (<hui-root>) ved at gå opad gennem shadow DOM
    _findRoot() {
      let n = this;
      while (n) {
        if (n.localName === 'hui-root') return n;
        n = n.parentNode || n.host;
      }
      return null;
    }

    // Beregner vejr + dag/nat ud fra entiteterne
    _updateEnv() {
      const c = this._config;
      const st = (this._hass && this._hass.states) || {};
      let ws;
      if (c.weather_override && c.weather_override !== 'auto') ws = c.weather_override;
      else if (c.weather_entity && st[c.weather_entity]) ws = st[c.weather_entity].state;
      const sun = st[c.sun_entity];
      let night;
      if (sun) night = sun.state === 'below_horizon';
      else if (ws === 'clear-night') night = true;
      else {
        const hr = new Date().getHours();
        night = hr < 7 || hr >= 20;
      }
      this._env = { cat: mapWeather(ws), night };
      if (Bg.owner === this && Bg.engine) Bg.engine.env = this._env;
      if (this._preview) this._preview.env = this._env;
      this._updateLabel();
    }

    _buildDom() {
      if (this._built) return;
      this._built = true;
      const sr = this.attachShadow({ mode: 'open' });
      sr.innerHTML = `
        <style>
          :host{display:block;height:100%}
          ha-card{overflow:hidden;position:relative;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center}
          canvas{display:block;width:100%;height:auto;aspect-ratio:16/9}
          canvas[hidden]{display:none}
          .info{display:flex;align-items:center;gap:12px;padding:12px 16px}
          .info ha-icon{color:var(--primary-color)}
          .info b{display:block}
          .sub{font-size:12px;color:var(--secondary-text-color)}
          .over{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,.55));color:#fff;padding:18px 14px 8px;font-size:12px}
        </style>
        <ha-card>
          <canvas class="pv" hidden></canvas>
          <div class="info"><ha-icon icon="mdi:weather-partly-snowy-rainy"></ha-icon>
            <div><b>Ambient Backdrop</b><span class="sub"></span></div></div>
        </ha-card>`;
      this._canvas = sr.querySelector('canvas');
      this._info = sr.querySelector('.info');
      this._sub = sr.querySelector('.sub');
    }

    // Baggrund i editorens mini-forhåndsvisning (billede/tema; video vises som sort)
    _previewBg(c) {
      const src = c.background_source;
      if (src === 'none') return '';
      const d = clamp(Number(c.background_dim) || 0, 0, 0.95);
      const dim = `linear-gradient(rgba(0,0,0,${d}),rgba(0,0,0,${d}))`;
      if (src === 'image' && c.background_image) {
        return `${dim}, center / cover no-repeat url("${cssUrl(c.background_image)}")`;
      }
      if (src === 'theme') return `${dim}, ${Bg._themeBg()}`;
      return '#000';
    }

    _updateLabel() {
      if (!this._sub) return;
      const c = this._config;
      const hass = this._hass;
      const style = t(hass, `style_${c.style}`).split(' (')[0]; // kort navn uden forklaring i parentes
      const cat = t(hass, `cat_${this._env.cat}`);
      const when = t(hass, this._env.night ? 'card_night' : 'card_day');
      this._sub.textContent = `${style} · ${cat} · ${when}`;
    }

    _sync(fromPoll) {
      if (!this._connected || !this._built) return;
      const root = this._findRoot();
      const c = this._config;

      if (root) {
        // Rigtigt dashboard: baggrunden kører bag kortene
        const edit = !!(root.lovelace && root.lovelace.editMode);
        const show = edit || c.always_show_preview;
        this.style.display = show ? '' : 'none';
        this._canvas.hidden = true;
        if (this._preview) {
          this._preview.stop();
          this._preview = null;
        }
        if (!fromPoll || Bg.owner !== this) Bg.claim(this, root);
        else if (Bg.engine) {
          Bg.engine.setConfig(c);
          Bg.engine.env = this._env;
          Bg.applyBackground(c); // fanger også, at temaet skifter
        }
      } else {
        // Editorens forhåndsvisning: lille mini-canvas i selve kortet
        this.style.display = '';
        this._canvas.hidden = false;
        if (!this._preview) {
          this._preview = new Engine(this._canvas, () => ({
            w: this._canvas.clientWidth || 300,
            h: this._canvas.clientHeight || 170,
          }));
          this._preview.quality = 0.7;
          this._preview.start();
        }
        this._canvas.style.background = this._previewBg(c);
        this._preview.setConfig(c);
        this._preview.env = this._env;
      }
      this._updateLabel();
    }
  }

  /* ======================================================================
   * 8. TEKSTER (DANSK OG ENGELSK)
   *    Alle tekster i editoren og på kortet står her. Sproget følger HA's
   *    sprogindstilling. Mangler en tekst i et sprog, bruges den engelske.
   *    Nøgler:
   *      <indstilling>        feltets navn i editoren (samme navn som i DEFAULTS)
   *      help_<indstilling>   hjælpetekst under feltet
   *      style_<stil>         navn på en stil
   *      opt_<felt>_<værdi>   valgmulighed i en liste
   *      sec_<navn>           titel på en sektion
   *      cat_<vejr>, card_*   tekster på selve kortet
   *    Nyt sprog: kopiér hele en-blokken, giv den sprogkoden (fx de) og oversæt.
   * ==================================================================== */
  const STRINGS = {
    en: {
      // Stilarter
      style_particles: 'Particles with lines',
      style_network: 'Network with signals',
      style_flow: 'Flow field (drifting trails)',
      style_matrix: 'Matrix (falling characters, runes etc.)',
      style_retro: 'Retro grid',
      style_hex: 'Hex grid',
      style_aurora: 'Aurora (northern lights)',
      style_curtains: 'Aurora curtains',
      style_starfield: 'Starfield',
      style_fireflies: 'Fireflies',
      style_dust: 'Dust in light beams',
      style_bokeh: 'Bokeh (soft light orbs)',
      style_lava: 'Lava lamp',
      style_gradient: 'Flowing gradient',
      style_waves: 'Waves (ocean)',
      style_rainwindow: 'Rain on window',

      // Sektioner
      sec_style: 'Settings for',
      sec_bg: 'Background (behind the animation)',
      sec_colors: 'Colors',
      sec_weather: 'Weather overlay',
      sec_adv: 'Advanced',

      // Valgmuligheder
      opt_fireflies_color_warm: 'Yellow-green (classic)',
      opt_fireflies_color_amber: 'Amber',
      opt_fireflies_color_palette: 'Follow the palette',
      opt_matrix_charset_katakana: 'Katakana + digits (classic)',
      opt_matrix_charset_runes: 'Runes (Elder Futhark)',
      opt_matrix_charset_mix: 'Katakana and runes mixed',
      opt_matrix_charset_binary: 'Binary (0 and 1)',
      opt_matrix_charset_hex: 'Hex (0-F)',
      opt_matrix_charset_ascii: 'Code symbols',
      opt_matrix_charset_custom: 'Custom characters',
      opt_matrix_color_green: 'Classic green',
      opt_matrix_color_palette: 'Follow weather/palette',
      opt_matrix_color_rainbow: 'Rainbow',
      opt_background_source_none: 'None (colored background from the animation)',
      opt_background_source_theme: 'Theme background',
      opt_background_source_image: 'Own image',
      opt_background_source_video: 'Video (mp4, loop)',
      opt_color_mode_auto: 'Automatic (weather + day/night)',
      opt_color_mode_manual: 'Manual',
      opt_weather_override_auto: 'Automatic (from weather entity)',
      opt_weather_override_clear: 'Test: clear',
      opt_weather_override_partly: 'Test: partly cloudy',
      opt_weather_override_cloudy: 'Test: cloudy',
      opt_weather_override_rain: 'Test: rain',
      opt_weather_override_pour: 'Test: downpour',
      opt_weather_override_storm: 'Test: thunderstorm',
      opt_weather_override_snow: 'Test: snow',
      opt_weather_override_fog: 'Test: fog',

      // Kortet
      card_day: 'day',
      card_night: 'night',
      cat_clear: 'clear',
      cat_partly: 'partly cloudy',
      cat_cloudy: 'cloudy',
      cat_rain: 'rain',
      cat_pour: 'downpour',
      cat_storm: 'thunderstorm',
      cat_snow: 'snow',
      cat_fog: 'fog',

      // Felter
      style: 'Style',
      animation_enabled: 'Show animation (particles etc.)',
      weather_entity: 'Weather entity',
      sun_entity: 'Sun entity (day/night)',
      opacity: 'Animation opacity',
      speed: 'Speed',
      density: 'Amount',
      interaction: 'Mouse/touch affects the animation',
      max_fps: 'Max FPS',
      fill_background: 'Draw colored background (only when Background = None)',
      background_source: 'Background type',
      background_image: 'Image (path or URL)',
      background_video: 'Video, mp4 (path or URL)',
      background_video_speed: 'Video speed',
      background_dim: 'Darkening on top of the background',
      background_blur: 'Blur (px)',
      dither: 'Smooth color steps (noise against banding)',
      dither_strength: 'Noise strength',
      color_mode: 'Color mode',
      color_primary: 'Primary color',
      color_secondary: 'Secondary color',
      weather_overlay: 'Weather overlay on/off',
      rain: 'Rain',
      snow: 'Snow',
      fog: 'Fog',
      stars: 'Stars on a clear night sky',
      weather_override: 'Weather (test/override)',
      particles_line_distance: 'Line distance',
      particles_line_opacity: 'Line visibility',
      particles_size: 'Particle size',
      bokeh_size: 'Orb size',
      bokeh_soft: 'Softness',
      aurora_bands: 'Number of bands',
      aurora_height: 'Height',
      aurora_intensity: 'Intensity',
      starfield_size: 'Star size',
      starfield_twinkle: 'Twinkling stars',
      starfield_parallax: 'Parallax (depth)',
      starfield_shooting: 'Shooting stars',
      gradient_blobs: 'Number of color blobs',
      gradient_size: 'Blob size',
      curtains_layers: 'Number of curtains',
      curtains_height: 'Height',
      curtains_rays: 'Number of rays',
      waves_layers: 'Number of wave layers',
      waves_height: 'Wave height',
      waves_glow: 'Glow at the horizon',
      waves_foam: 'Foam edge',
      rainwindow_size: 'Drop size',
      rainwindow_rate: 'How often drops run',
      rainwindow_trails: 'Trails behind the drops',
      rainwindow_lights: 'Lights behind the window',
      rainwindow_natural: 'Natural variation',
      fireflies_size: 'Size',
      fireflies_glow: 'Glow',
      fireflies_blink: 'Blink (0 = constant light)',
      fireflies_color: 'Color',
      matrix_charset: 'Character set',
      matrix_custom: 'Custom characters',
      matrix_font: 'Font (optional)',
      matrix_size: 'Character size',
      matrix_trail: 'Trail length',
      matrix_variation: 'Variation in speed and trail',
      matrix_color: 'Color',
      matrix_head: 'Glowing head on each column',
      matrix_glow: 'Glow around the head',
      matrix_glow_style: 'Glow shape',
      opt_matrix_glow_style_glyph: 'The character itself glows',
      opt_matrix_glow_style_round: 'Round soft spot',
      matrix_smooth: 'Smooth head movement',
      matrix_depth: 'Depth (a back layer with small characters)',
      matrix_mirror: 'Mirror the characters (like the movie)',
      matrix_mutate: 'How often characters change',
      hex_size: 'Hexagon size',
      hex_grid: 'Show the grid',
      hex_fill: 'Fill the lit cells',
      hex_waves: 'Light waves across the grid',
      hex_ripples: 'Ripples',
      lava_blobs: 'Number of blobs',
      lava_size: 'Blob size',
      lava_soft: 'Edge softness',
      lava_glow: 'Brighter center',
      dust_beams: 'Number of light beams',
      dust_angle: 'Direction (degrees)',
      dust_origin: 'Position of the light at the top',
      dust_strength: 'Brightness',
      dust_motes: 'Dust motes',
      dust_wind: 'Swirling in the wind',
      flow_trail: 'Trail length',
      flow_speed: 'Speed',
      flow_scale: 'Size of the currents',
      flow_width: 'Line thickness',
      flow_weather: 'Weather drives the wind',
      flow_glow: 'Glowing heads',
      flow_color_dir: 'Color by direction',
      network_size: 'Node size',
      network_distance: 'Size of the clusters',
      network_shape: 'Line shape',
      network_labels: 'Small texts (addresses)',
      network_scan: 'Scan rings',
      network_color: 'Colors',
      opt_network_shape_angled: 'Angled (right angles)',
      opt_network_shape_diagonal: 'Diagonal (45° corners)',
      opt_network_shape_curved: 'Curved',
      opt_network_shape_straight: 'Straight',
      opt_network_shape_mixed: 'Mixed',
      opt_network_color_terminal: 'Terminal green',
      opt_network_color_cyber: 'Cyber (cyan and magenta)',
      opt_network_color_amber: 'Amber (old screen)',
      opt_network_color_red: 'Red alert',
      opt_network_color_ice: 'Ice (white and light blue)',
      opt_network_color_palette: 'Follow the palette',
      network_rate: 'How often signals are sent',
      network_speed: 'Signal speed',
      network_glow: 'Glow on nodes and signals',
      retro_speed: 'Speed',
      retro_horizon: 'Height of the horizon',
      retro_lines: 'Grid density',
      retro_sun: 'Sun and moon',
      retro_skyline: 'Horizon',
      retro_sea: 'Sea instead of grid',
      retro_sky: 'Colored sky',
      opt_retro_skyline_mountains: 'Mountains',
      opt_retro_skyline_city: 'Skyline (art deco)',
      opt_retro_skyline_none: 'None',
      opt_retro_color_miami: 'Miami (pink and turquoise)',
      retro_glow: 'Glow',
      retro_color: 'Colors',
      opt_retro_color_palette: 'Follow the palette',
      opt_retro_color_classic: 'Classic neon',
      respect_reduced_motion: 'Respect "reduce motion"',
      always_show_preview: 'Show the card outside edit mode too',

      // Hjælpetekster
      help_animation_enabled: 'Turn off to show only the background/video (the weather overlay has its own switch).',
      help_weather_override: 'Use it to test rain, snow etc. without waiting for the weather. Set it back to Automatic afterwards.',
      help_density: 'Mobile and slow devices automatically get fewer.',
      help_always_show_preview: 'Otherwise the card is invisible when you are not editing.',
      help_dither_strength: 'Raise it if you still see bands. Lower it if you see grain. 0 = off.',
      help_background_source: 'The theme background uses the image/color your theme sets (lovelace-background).',
      help_background_image: 'E.g. /local/backgrounds/my-image.jpg (the file lives in /config/www/backgrounds/).',
      help_background_video: 'E.g. /local/backgrounds/loop.mp4. Plays muted in a loop. Use H.264.',
      help_background_dim: 'Makes the background darker so particles and weather stand out.',
      help_background_blur: 'Blur is heavier on videos. Keep it low on old devices.',
      help_matrix_charset: 'Runes and katakana need a font that has the characters. If you see squares, enter an installed font under Font.',
      help_matrix_custom: 'Enter the characters to use, e.g. your name or ᚠᚢᚦᚨᚱᚲ.',
      help_matrix_font: 'E.g. Noto Sans Runic or Segoe UI Historic. Empty = automatic.',
      help_matrix_depth: 'Draws an extra layer behind with smaller, fainter and slower characters.',
      help_matrix_mirror: 'Mirrors every character, like in the movie.',
      help_rainwindow_rate: 'Higher = more drops running down the window.',
      help_matrix_smooth: 'The head glides between rows instead of jumping. Turn off for the stepped look of the film.',
      help_rainwindow_natural: 'Many small and a few large drops, teardrop shapes while running, and small droplets left behind.',
      help_lava_soft: 'Lower = sharper blobs. Higher = softer and more fluid.',
      help_flow_weather: 'Rain and storm make the trails faster and slanted.',
      help_flow_scale: 'Higher = larger, slower swirls. Lower = tighter swirls.',
      help_network_rate: '0 = no signals.',
      help_network_distance: 'How far the small nodes sit from their hub.',
      help_network_labels: 'Hubs show an address. Small nodes show a code when a signal hits them.',
      help_retro_sun: 'A sun by day and a moon by night.',
      help_retro_sky: 'Paints a sunset sky. It covers the background behind the card, so leave it off if you use a background image.',
      help_retro_color: 'The palette follows the weather and time of day. Classic neon is magenta and orange.',
      help_dust_wind: '0 = the dust only drifts calmly. Higher = more wind and swirls. Rain and storm add wind, and the mouse stirs the dust.',
      help_dust_angle: '0 = straight down. Positive numbers point to the right, negative to the left.',
      help_fireflies_blink: '0 = always lit, 1 = clearly blinking.',
    },

    da: {
      // Stilarter
      style_particles: 'Partikler med linjer',
      style_network: 'Netværk med signaler',
      style_flow: 'Strømning (flydende spor)',
      style_matrix: 'Matrix (tegn-regn, runer m.m.)',
      style_retro: 'Retro-gitter',
      style_hex: 'Hexagon-net',
      style_aurora: 'Aurora (nordlys)',
      style_curtains: 'Nordlys-gardiner',
      style_starfield: 'Stjernehimmel',
      style_fireflies: 'Ildfluer',
      style_dust: 'Støv i lysstråler',
      style_bokeh: 'Bokeh (bløde lysbobler)',
      style_lava: 'Lavalampe',
      style_gradient: 'Flydende gradient',
      style_waves: 'Bølger (hav)',
      style_rainwindow: 'Regnvindue',

      // Sektioner
      sec_style: 'Indstillinger for',
      sec_bg: 'Baggrund (bag animationen)',
      sec_colors: 'Farver',
      sec_weather: 'Vejr-overlay',
      sec_adv: 'Avanceret',

      // Valgmuligheder
      opt_fireflies_color_warm: 'Gulgrøn (klassisk)',
      opt_fireflies_color_amber: 'Rav',
      opt_fireflies_color_palette: 'Følg paletten',
      opt_matrix_charset_katakana: 'Katakana + tal (klassisk)',
      opt_matrix_charset_runes: 'Runer (ældre futhark)',
      opt_matrix_charset_mix: 'Katakana og runer blandet',
      opt_matrix_charset_binary: 'Binær (0 og 1)',
      opt_matrix_charset_hex: 'Hex (0-F)',
      opt_matrix_charset_ascii: 'Kode-tegn',
      opt_matrix_charset_custom: 'Egne tegn',
      opt_matrix_color_green: 'Klassisk grøn',
      opt_matrix_color_palette: 'Følg vejr/palette',
      opt_matrix_color_rainbow: 'Regnbue',
      opt_background_source_none: 'Ingen (farvet baggrund fra animationen)',
      opt_background_source_theme: 'Temaets baggrund',
      opt_background_source_image: 'Eget billede',
      opt_background_source_video: 'Video (mp4, loop)',
      opt_color_mode_auto: 'Automatisk (vejr + dag/nat)',
      opt_color_mode_manual: 'Manuel',
      opt_weather_override_auto: 'Automatisk (fra vejr-entitet)',
      opt_weather_override_clear: 'Test: klart',
      opt_weather_override_partly: 'Test: delvist skyet',
      opt_weather_override_cloudy: 'Test: skyet',
      opt_weather_override_rain: 'Test: regn',
      opt_weather_override_pour: 'Test: styrtregn',
      opt_weather_override_storm: 'Test: torden',
      opt_weather_override_snow: 'Test: sne',
      opt_weather_override_fog: 'Test: tåge',

      // Kortet
      card_day: 'dag',
      card_night: 'nat',
      cat_clear: 'klart',
      cat_partly: 'delvist skyet',
      cat_cloudy: 'skyet',
      cat_rain: 'regn',
      cat_pour: 'styrtregn',
      cat_storm: 'torden',
      cat_snow: 'sne',
      cat_fog: 'tåge',

      // Felter
      style: 'Stil',
      animation_enabled: 'Vis animation (partikler m.m.)',
      weather_entity: 'Vejr-entitet',
      sun_entity: 'Sol-entitet (dag/nat)',
      opacity: 'Gennemsigtighed på animation',
      speed: 'Hastighed',
      density: 'Antal (mængde)',
      interaction: 'Mus/touch påvirker animationen',
      max_fps: 'Maks. FPS',
      fill_background: 'Tegn farvet baggrund (kun når Baggrund = Ingen)',
      background_source: 'Baggrundstype',
      background_image: 'Billede (sti eller URL)',
      background_video: 'Video, mp4 (sti eller URL)',
      background_video_speed: 'Videohastighed',
      background_dim: 'Mørklægning oven på baggrunden',
      background_blur: 'Sløring (px)',
      dither: 'Udjævn farvetrin (støj mod striber)',
      dither_strength: 'Støjstyrke',
      color_mode: 'Farvetilstand',
      color_primary: 'Primær farve',
      color_secondary: 'Sekundær farve',
      weather_overlay: 'Vejr-overlay til/fra',
      rain: 'Regn',
      snow: 'Sne',
      fog: 'Tåge',
      stars: 'Stjerner på klar nattehimmel',
      weather_override: 'Vejr (test/overstyr)',
      particles_line_distance: 'Linjeafstand',
      particles_line_opacity: 'Linje-synlighed',
      particles_size: 'Partikelstørrelse',
      bokeh_size: 'Bobbelstørrelse',
      bokeh_soft: 'Blødhed',
      aurora_bands: 'Antal bånd',
      aurora_height: 'Højde',
      aurora_intensity: 'Intensitet',
      starfield_size: 'Stjernestørrelse',
      starfield_twinkle: 'Blinkende stjerner',
      starfield_parallax: 'Parallakse (dybde)',
      starfield_shooting: 'Stjerneskud',
      gradient_blobs: 'Antal farveklatter',
      gradient_size: 'Klatternes størrelse',
      curtains_layers: 'Antal gardiner',
      curtains_height: 'Højde',
      curtains_rays: 'Antal stråler',
      waves_layers: 'Antal bølgelag',
      waves_height: 'Bølgehøjde',
      waves_glow: 'Glød ved horisonten',
      waves_foam: 'Skumkant',
      rainwindow_size: 'Dråbestørrelse',
      rainwindow_rate: 'Hvor ofte dråber løber',
      rainwindow_trails: 'Spor efter dråberne',
      rainwindow_lights: 'Lys bag ruden',
      rainwindow_natural: 'Naturlig variation',
      fireflies_size: 'Størrelse',
      fireflies_glow: 'Glød',
      fireflies_blink: 'Blink (0 = lyser konstant)',
      fireflies_color: 'Farve',
      matrix_charset: 'Tegnsæt',
      matrix_custom: 'Egne tegn',
      matrix_font: 'Skrifttype (valgfri)',
      matrix_size: 'Tegnstørrelse',
      matrix_trail: 'Halens længde',
      matrix_variation: 'Variation i fart og hale',
      matrix_color: 'Farve',
      matrix_head: 'Lysende hoved på hver kolonne',
      matrix_glow: 'Glød omkring hovedet',
      matrix_glow_style: 'Glødens form',
      opt_matrix_glow_style_glyph: 'Selve tegnet lyser',
      opt_matrix_glow_style_round: 'Rund blød plet',
      matrix_smooth: 'Glidende hoved',
      matrix_depth: 'Dybde (et bagerste lag med små tegn)',
      matrix_mirror: 'Spejlvend tegnene (som i filmen)',
      matrix_mutate: 'Hvor ofte tegnene skifter',
      hex_size: 'Hexagon-størrelse',
      hex_grid: 'Vis nettet',
      hex_fill: 'Fyld de lysende felter',
      hex_waves: 'Lysbølger henover nettet',
      hex_ripples: 'Krusninger',
      lava_blobs: 'Antal klatter',
      lava_size: 'Klatternes størrelse',
      lava_soft: 'Blødhed på kanterne',
      lava_glow: 'Lysere midte',
      dust_beams: 'Antal lysstråler',
      dust_angle: 'Retning (grader)',
      dust_origin: 'Lysets placering foroven',
      dust_strength: 'Lysstyrke',
      dust_motes: 'Støvkorn',
      dust_wind: 'Hvirvler i vinden',
      flow_trail: 'Sporlængde',
      flow_speed: 'Fart',
      flow_scale: 'Strømningernes størrelse',
      flow_width: 'Stregtykkelse',
      flow_weather: 'Vejret styrer vinden',
      flow_glow: 'Lysende hoveder',
      flow_color_dir: 'Farve efter retning',
      network_size: 'Knudestørrelse',
      network_distance: 'Klyngernes størrelse',
      network_shape: 'Linjeform',
      network_labels: 'Små tekster (adresser)',
      network_scan: 'Scanningsringe',
      network_color: 'Farver',
      opt_network_shape_angled: 'Vinklede (rette vinkler)',
      opt_network_shape_diagonal: 'Diagonale (45°-knæk)',
      opt_network_shape_curved: 'Kurvede',
      opt_network_shape_straight: 'Lige',
      opt_network_shape_mixed: 'Blandet',
      opt_network_color_terminal: 'Terminal-grøn',
      opt_network_color_cyber: 'Cyber (cyan og magenta)',
      opt_network_color_amber: 'Rav (gammel skærm)',
      opt_network_color_red: 'Rød alarm',
      opt_network_color_ice: 'Is (hvid og lyseblå)',
      opt_network_color_palette: 'Følg paletten',
      network_rate: 'Hvor ofte signaler sendes',
      network_speed: 'Signalernes fart',
      network_glow: 'Glød på knuder og signaler',
      retro_speed: 'Fart',
      retro_horizon: 'Horisontens højde',
      retro_lines: 'Gittertæthed',
      retro_sun: 'Sol og måne',
      retro_skyline: 'Horisont',
      retro_sea: 'Hav i stedet for gitter',
      retro_sky: 'Farvet himmel',
      opt_retro_skyline_mountains: 'Bjerge',
      opt_retro_skyline_city: 'Skyline (art deco)',
      opt_retro_skyline_none: 'Ingen',
      opt_retro_color_miami: 'Miami (pink og turkis)',
      retro_glow: 'Glød',
      retro_color: 'Farver',
      opt_retro_color_palette: 'Følg paletten',
      opt_retro_color_classic: 'Klassisk neon',
      respect_reduced_motion: 'Respektér "reducer bevægelse"',
      always_show_preview: 'Vis kortet også uden for redigering',

      // Hjælpetekster
      help_animation_enabled: 'Slå fra for kun at se baggrunden/videoen (vejr-overlay har sin egen kontakt).',
      help_weather_override: 'Bruges til at teste regn, sne osv. uden at vente på vejret. Sæt tilbage til Automatisk bagefter.',
      help_density: 'Mobil og langsomme enheder får automatisk færre.',
      help_always_show_preview: 'Ellers er kortet usynligt, når der ikke redigeres.',
      help_dither_strength: 'Hæv den, hvis der stadig ses bånd. Sænk den, hvis der ses korn. 0 = fra.',
      help_background_source: 'Temaets baggrund bruger det billede/den farve, temaet har sat (lovelace-background).',
      help_background_image: 'Fx /local/backgrounds/mit-billede.jpg (filen ligger i /config/www/backgrounds/).',
      help_background_video: 'Fx /local/backgrounds/loop.mp4. Afspilles lydløst i loop. Brug H.264.',
      help_background_dim: 'Gør baggrunden mørkere, så partikler og vejr står tydeligere.',
      help_background_blur: 'Sløring er tungere på videoer. Hold den lav på gamle enheder.',
      help_matrix_charset: 'Runer og katakana kræver en skrifttype, der har tegnene. Vises der firkanter, så skriv en installeret skrifttype under Skrifttype.',
      help_matrix_custom: 'Skriv de tegn, der skal bruges, fx et navn eller ᚠᚢᚦᚨᚱᚲ.',
      help_matrix_font: 'Fx Noto Sans Runic eller Segoe UI Historic. Tom = automatisk.',
      help_matrix_depth: 'Tegner et ekstra lag bagved med mindre, svagere og langsommere tegn.',
      help_matrix_mirror: 'Spejlvender hvert tegn, som i filmen.',
      help_rainwindow_rate: 'Højere tal = flere dråber, der løber ned ad ruden.',
      help_matrix_smooth: 'Hovedet glider mellem rækkerne i stedet for at springe. Slå fra for filmens trinvise udseende.',
      help_rainwindow_natural: 'Mange små og få store dråber, dråbeform når de løber, og små dråber, der bliver efterladt.',
      help_lava_soft: 'Lavere = skarpere klatter. Højere = blødere og mere flydende.',
      help_flow_weather: 'Regn og storm gør sporene hurtigere og mere skrå.',
      help_flow_scale: 'Højere = større og langsommere sving. Lavere = tættere sving.',
      help_network_rate: '0 = ingen signaler.',
      help_network_distance: 'Hvor langt de små knuder ligger fra deres hub.',
      help_network_labels: 'Hubs viser en adresse. Små knuder viser en kode, når et signal rammer dem.',
      help_retro_sun: 'En sol om dagen og en måne om natten.',
      help_retro_sky: 'Maler en solnedgangshimmel. Den dækker baggrunden bag kortet, så lad den være slået fra, hvis du bruger et baggrundsbillede.',
      help_retro_color: 'Paletten følger vejr og tidspunkt. Klassisk neon er magenta og orange.',
      help_dust_wind: '0 = støvet driver bare roligt. Højere = mere vind og hvirvler. Regn og storm giver mere vind, og musen rører rundt i støvet.',
      help_dust_angle: '0 = lige ned. Positive tal peger skråt mod højre, negative mod venstre.',
      help_fireflies_blink: '0 = lyser hele tiden, 1 = blinker tydeligt.',
    },
  };

  // HA's sprogkode, fx "da" eller "pt-BR". Prøver først hele koden, derefter kun de to første bogstaver.
  const langOf = (hass) => (hass && ((hass.locale && hass.locale.language) || hass.language)) || 'en';

  // Slår en tekst op: valgt sprog, derefter engelsk. Returnerer undefined, hvis nøglen ikke findes.
  function tryT(hass, key) {
    const l = langOf(hass);
    const d = STRINGS[l] || STRINGS[l.split('-')[0]];
    if (d && d[key] !== undefined) return d[key];
    return STRINGS.en[key];
  }

  // Som tryT, men viser selve nøglen, hvis teksten mangler overalt.
  const t = (hass, key) => {
    const v = tryT(hass, key);
    return v === undefined ? key : v;
  };

  /* ======================================================================
   * 9. EDITOREN
   *    Bygger formularen med HA's egen <ha-form>. Feltgruppen med stilens egne
   *    indstillinger skifter, når en anden stil vælges. Tekster hentes fra STRINGS.
   * ==================================================================== */
  const STYLE_IDS = ['particles', 'network', 'flow', 'matrix', 'retro', 'hex', 'aurora', 'curtains', 'starfield', 'fireflies', 'dust', 'bokeh', 'lava', 'gradient', 'waves', 'rainwindow'];

  const slider = (min, max, step) => ({ number: { min, max, step, mode: 'slider' } });

  // Liste med oversatte valgmuligheder: opts('matrix_charset', ['katakana', ...], tr)
  const opts = (field, values, tr) => ({
    select: { mode: 'dropdown', options: values.map((v) => ({ value: v, label: tr(`opt_${field}_${v}`) })) },
  });

  // Egne indstillinger pr. stil
  function styleSchema(style, cfg, tr) {
    switch (style) {
      case 'particles':
        return [
          { name: 'particles_line_distance', selector: slider(60, 260, 5) },
          { name: 'particles_line_opacity', selector: slider(0.05, 1, 0.05) },
          { name: 'particles_size', selector: slider(0.5, 3, 0.1) },
        ];
      case 'bokeh':
        return [
          { name: 'bokeh_size', selector: slider(0.4, 2.5, 0.1) },
          { name: 'bokeh_soft', selector: slider(0, 1, 0.05) },
        ];
      case 'aurora':
        return [
          { name: 'aurora_bands', selector: slider(2, 7, 1) },
          { name: 'aurora_height', selector: slider(0.5, 2, 0.1) },
          { name: 'aurora_intensity', selector: slider(0.3, 1.5, 0.05) },
        ];
      case 'starfield':
        return [
          { name: 'starfield_size', selector: slider(0.5, 3, 0.1) },
          { name: 'starfield_twinkle', selector: { boolean: {} } },
          { name: 'starfield_parallax', selector: { boolean: {} } },
          { name: 'starfield_shooting', selector: { boolean: {} } },
        ];
      case 'gradient':
        return [
          { name: 'gradient_blobs', selector: slider(2, 9, 1) },
          { name: 'gradient_size', selector: slider(0.5, 1.8, 0.05) },
        ];
      case 'curtains':
        return [
          { name: 'curtains_layers', selector: slider(1, 4, 1) },
          { name: 'curtains_height', selector: slider(0.5, 2, 0.1) },
          { name: 'curtains_rays', selector: slider(6, 60, 1) },
        ];
      case 'waves':
        return [
          { name: 'waves_layers', selector: slider(2, 8, 1) },
          { name: 'waves_height', selector: slider(0.3, 2.5, 0.1) },
          { name: 'waves_glow', selector: { boolean: {} } },
          { name: 'waves_foam', selector: { boolean: {} } },
        ];
      case 'rainwindow':
        return [
          { name: 'rainwindow_size', selector: slider(0.5, 2.5, 0.1) },
          { name: 'rainwindow_rate', selector: slider(0.2, 3, 0.1) },
          { name: 'rainwindow_trails', selector: { boolean: {} } },
          { name: 'rainwindow_lights', selector: { boolean: {} } },
          { name: 'rainwindow_natural', selector: { boolean: {} } },
        ];
      case 'fireflies':
        return [
          { name: 'fireflies_size', selector: slider(0.5, 3, 0.1) },
          { name: 'fireflies_glow', selector: slider(0.3, 2.5, 0.1) },
          { name: 'fireflies_blink', selector: slider(0, 1, 0.05) },
          { name: 'fireflies_color', selector: opts('fireflies_color', ['warm', 'amber', 'palette'], tr) },
        ];
      case 'matrix':
        return [
          { name: 'matrix_charset', selector: opts('matrix_charset', ['katakana', 'runes', 'mix', 'binary', 'hex', 'ascii', 'custom'], tr) },
          ...(cfg && cfg.matrix_charset === 'custom' ? [{ name: 'matrix_custom', selector: { text: {} } }] : []),
          { name: 'matrix_color', selector: opts('matrix_color', ['green', 'palette', 'rainbow'], tr) },
          { name: 'matrix_size', selector: slider(10, 40, 1) },
          { name: 'matrix_trail', selector: slider(0.4, 2.5, 0.1) },
          { name: 'matrix_variation', selector: slider(0, 1.5, 0.1) },
          { name: 'matrix_mutate', selector: slider(0, 2, 0.1) },
          { name: 'matrix_head', selector: { boolean: {} } },
          { name: 'matrix_smooth', selector: { boolean: {} } },
          { name: 'matrix_glow_style', selector: opts('matrix_glow_style', ['glyph', 'round'], tr) },
          { name: 'matrix_glow', selector: slider(0, 2, 0.05) },
          { name: 'matrix_depth', selector: { boolean: {} } },
          { name: 'matrix_mirror', selector: { boolean: {} } },
          { name: 'matrix_font', selector: { text: {} } },
        ];
      case 'hex':
        return [
          { name: 'hex_size', selector: slider(20, 120, 2) },
          { name: 'hex_grid', selector: { boolean: {} } },
          { name: 'hex_fill', selector: { boolean: {} } },
          { name: 'hex_waves', selector: { boolean: {} } },
          { name: 'hex_ripples', selector: { boolean: {} } },
        ];
      case 'lava':
        return [
          { name: 'lava_blobs', selector: slider(3, 10, 1) },
          { name: 'lava_size', selector: slider(0.5, 2, 0.05) },
          { name: 'lava_soft', selector: slider(0.05, 1, 0.05) },
          { name: 'lava_glow', selector: { boolean: {} } },
        ];
      case 'flow':
        return [
          { name: 'flow_trail', selector: slider(6, 80, 1) },
          { name: 'flow_speed', selector: slider(0.3, 3, 0.1) },
          { name: 'flow_scale', selector: slider(0.4, 3, 0.1) },
          { name: 'flow_width', selector: slider(0.5, 3, 0.1) },
          { name: 'flow_glow', selector: { boolean: {} } },
          { name: 'flow_color_dir', selector: { boolean: {} } },
          { name: 'flow_weather', selector: { boolean: {} } },
        ];
      case 'network':
        return [
          { name: 'network_size', selector: slider(0.5, 3, 0.1) },
          { name: 'network_distance', selector: slider(0.5, 2, 0.1) },
          { name: 'network_rate', selector: slider(0, 3, 0.1) },
          { name: 'network_speed', selector: slider(0.3, 3, 0.1) },
          { name: 'network_glow', selector: { boolean: {} } },
          { name: 'network_shape', selector: opts('network_shape', ['angled', 'diagonal', 'curved', 'straight', 'mixed'], tr) },
          { name: 'network_labels', selector: { boolean: {} } },
          { name: 'network_scan', selector: { boolean: {} } },
          { name: 'network_color', selector: opts('network_color', ['terminal', 'cyber', 'amber', 'red', 'ice', 'palette'], tr) },
        ];
      case 'retro':
        return [
          { name: 'retro_speed', selector: slider(0, 3, 0.1) },
          { name: 'retro_horizon', selector: slider(0.3, 0.8, 0.01) },
          { name: 'retro_lines', selector: slider(6, 30, 1) },
          { name: 'retro_sun', selector: { boolean: {} } },
          { name: 'retro_skyline', selector: opts('retro_skyline', ['mountains', 'city', 'none'], tr) },
          { name: 'retro_sea', selector: { boolean: {} } },
          { name: 'retro_sky', selector: { boolean: {} } },
          { name: 'retro_glow', selector: slider(0, 2, 0.1) },
          { name: 'retro_color', selector: opts('retro_color', ['palette', 'classic', 'miami'], tr) },
        ];
      case 'dust':
        return [
          { name: 'dust_beams', selector: slider(1, 8, 1) },
          { name: 'dust_angle', selector: slider(-60, 60, 1) },
          { name: 'dust_origin', selector: slider(0, 1, 0.05) },
          { name: 'dust_strength', selector: slider(0.3, 2, 0.05) },
          { name: 'dust_motes', selector: { boolean: {} } },
          { name: 'dust_wind', selector: slider(0, 2, 0.1) },
        ];
      default:
        return [];
    }
  }

  function buildSchema(cfg, tr) {
    const style = cfg.style || DEFAULTS.style;
    const styleName = tr(`style_${style}`);
    const manual = cfg.color_mode === 'manual';
    const src = cfg.background_source || DEFAULTS.background_source;
    return [
      { name: 'style', selector: { select: { mode: 'dropdown', options: STYLE_IDS.map((v) => ({ value: v, label: tr(`style_${v}`) })) } } },
      { name: 'animation_enabled', selector: { boolean: {} } },
      { name: 'weather_entity', selector: { entity: { domain: 'weather' } } },
      { name: 'opacity', selector: slider(0.1, 1, 0.05) },
      { name: 'speed', selector: slider(0.2, 3, 0.1) },
      { name: 'density', selector: slider(0.2, 2, 0.1) },
      { name: 'interaction', selector: { boolean: {} } },
      {
        type: 'expandable',
        name: 'sec_style',
        title: `${tr('sec_style')}: ${styleName}`,
        flatten: true,
        expanded: true,
        schema: styleSchema(style, cfg, tr),
      },
      {
        type: 'expandable',
        name: 'sec_bg',
        title: tr('sec_bg'),
        flatten: true,
        schema: [
          { name: 'background_source', selector: opts('background_source', ['none', 'theme', 'image', 'video'], tr) },
          ...(src === 'image' ? [{ name: 'background_image', selector: { text: {} } }] : []),
          ...(src === 'video'
            ? [
                { name: 'background_video', selector: { text: {} } },
                { name: 'background_video_speed', selector: slider(0.25, 2, 0.05) },
              ]
            : []),
          ...(src !== 'none'
            ? [
                { name: 'background_dim', selector: slider(0, 0.9, 0.05) },
                { name: 'background_blur', selector: slider(0, 20, 1) },
              ]
            : []),
        ],
      },
      {
        type: 'expandable',
        name: 'sec_colors',
        title: tr('sec_colors'),
        flatten: true,
        schema: [
          { name: 'color_mode', selector: opts('color_mode', ['auto', 'manual'], tr) },
          ...(manual
            ? [
                { name: 'color_primary', selector: { color_rgb: {} } },
                { name: 'color_secondary', selector: { color_rgb: {} } },
              ]
            : []),
        ],
      },
      {
        type: 'expandable',
        name: 'sec_weather',
        title: tr('sec_weather'),
        flatten: true,
        schema: [
          { name: 'weather_overlay', selector: { boolean: {} } },
          { name: 'rain', selector: { boolean: {} } },
          { name: 'snow', selector: { boolean: {} } },
          { name: 'fog', selector: { boolean: {} } },
          { name: 'stars', selector: { boolean: {} } },
          { name: 'weather_override', selector: opts('weather_override', ['auto', 'clear', 'partly', 'cloudy', 'rain', 'pour', 'storm', 'snow', 'fog'], tr) },
        ],
      },
      {
        type: 'expandable',
        name: 'sec_adv',
        title: tr('sec_adv'),
        flatten: true,
        schema: [
          { name: 'max_fps', selector: slider(15, 60, 5) },
          { name: 'fill_background', selector: { boolean: {} } },
          { name: 'dither', selector: { boolean: {} } },
          { name: 'dither_strength', selector: slider(0, 2, 0.1) },
          { name: 'sun_entity', selector: { entity: { domain: 'sun' } } },
          { name: 'respect_reduced_motion', selector: { boolean: {} } },
          { name: 'always_show_preview', selector: { boolean: {} } },
        ],
      },
    ];
  }

  class AmbientBackdropCardEditor extends HTMLElement {
    setConfig(config) {
      this._config = { ...config };
      this._render();
    }

    set hass(hass) {
      const lang = langOf(hass);
      this._hass = hass;
      if (this._form) this._form.hass = hass;
      // Tekster i valglister ligger i skemaet, så formularen bygges igen ved sprogskift
      if (this._lang !== lang) {
        this._lang = lang;
        if (this._config) this._render();
      }
    }

    _render() {
      if (!this._form) {
        this._form = document.createElement('ha-form');
        this._form.computeLabel = (s) => tryT(this._hass, s.name) || s.name;
        this._form.computeHelper = (s) => tryT(this._hass, `help_${s.name}`);
        this._form.addEventListener('value-changed', (ev) => {
          ev.stopPropagation();
          const merged = { ...this._config, ...ev.detail.value };
          // Gem kun værdier, der afviger fra standard, så YAML'en holdes pæn
          const config = { type: this._config.type };
          for (const k of Object.keys(merged)) {
            if (k === 'type') continue;
            const def = DEFAULTS[k];
            if (k === 'style' || JSON.stringify(merged[k]) !== JSON.stringify(def)) config[k] = merged[k];
          }
          this._config = config;
          this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
          this._render();
        });
        this.appendChild(this._form);
      }
      const data = { ...DEFAULTS, ...this._config };
      this._form.hass = this._hass;
      this._form.data = data;
      this._form.schema = buildSchema(data, (k) => t(this._hass, k));
    }
  }

  /* ======================================================================
   * REGISTRERING
   * ==================================================================== */
  if (!customElements.get('ambient-backdrop-card')) {
    customElements.define('ambient-backdrop-card', AmbientBackdropCard);
    customElements.define('ambient-backdrop-card-editor', AmbientBackdropCardEditor);
  }

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'ambient-backdrop-card',
    name: 'Ambient Backdrop',
    description: 'Animated dashboard background (particles, aurora, matrix and more) that reacts to weather and day/night.',
    preview: false,
  });

  console.info(
    `%c AMBIENT-BACKDROP-CARD %c v${VERSION} `,
    'color:#fff;background:#3b7ddd;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px',
    'color:#3b7ddd;background:#e8f0fc;font-weight:700;border-radius:0 3px 3px 0;padding:2px 4px'
  );
})();
