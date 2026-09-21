/* glass.js — 液态玻璃（框架无关：一条 <script> + 一组 CSS 变量）
 *
 * 思路来自 Shu Ding 的 liquid-glass / liquid-diamond（SVG 位移滤镜那一路）：
 *   1. 用 canvas 按元素自己的尺寸和圆角，逐像素算出一张位移贴图：
 *      R 通道存 X 位移、G 通道存 Y 位移，0.5 表示不动；
 *      "离边缘越近，采样点越往中心拉"，形成边缘的凸起折射；
 *   2. 这张贴图交给 feDisplacementMap，作为 backdrop-filter 作用在元素背后；
 *   3. 模糊和饱和度也放在滤镜内部，避免和 url() 抢同一条 backdrop-filter。
 *
 * 用法：容器加 .glass 类即可，脚本会自动扫描、按尺寸生成贴图，
 *      尺寸变化（转屏、拉伸）时自动重算。
 * 调参：CSS 变量 --lg-*（见 styles.css 的 :root）。
 */
(function () {
  "use strict";

  var FILTER_ID = "lg-refract";
  var SVG_ID = "lg-glass-defs";
  /* 贴图是一张平滑的位移场，不需要按屏幕像素精度来算：
     限制采样密度可以显著降低每次重算的开销（切页时的"卡一下"就来自这里） */
  var MAP_DPI = Math.min(1.5, window.devicePixelRatio || 1);
  var MAP_MAX_WIDTH = 480;

  var svg = null;
  var feMap = null;
  var feDisp = null;
  var feBlur = null;
  var feSat = null;
  var current = null; // 当前贴图对应的签名，避免重复计算

  /* ---------- 数学小工具（和参考实现一致） ---------- */

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function smoothStep(a, b, t) {
    t = clamp((t - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* 圆角矩形的有符号距离：内部为负、边缘为 0、外部为正 */
  function roundedRectSDF(x, y, halfWidth, halfHeight, radius) {
    var qx = Math.abs(x) - halfWidth + radius;
    var qy = Math.abs(y) - halfHeight + radius;
    var outside = Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0));
    return Math.min(Math.max(qx, qy), 0) + outside - radius;
  }

  function cssNumber(name, fallback) {
    var raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    var value = parseFloat(raw);
    return isFinite(value) ? value : fallback;
  }

  /* ---------- 生成位移贴图 ---------- */

  function buildMapData(width, height, radius, band, strength) {
    var scaleToFit = Math.min(1, MAP_MAX_WIDTH / Math.max(1, width));
    var dpi = MAP_DPI * scaleToFit;
    var w = Math.max(1, Math.round(width * dpi));
    var h = Math.max(1, Math.round(height * dpi));
    var bandPx = Math.max(1, band * dpi);
    var halfW = w / 2;
    var halfH = h / 2;
    var r = Math.min(radius * dpi, halfH, halfW);

    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    var image = ctx.createImageData(w, h);
    var data = image.data;
    var deltas = new Float32Array(w * h * 2);
    var maxDelta = 0;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var dx = x + 0.5 - halfW;
        var dy = y + 0.5 - halfH;
        var distance = -roundedRectSDF(dx, dy, halfW, halfH, r); // 距边缘的深度，内部为正
        var weight = 1 - smoothStep(0, bandPx, distance); // 贴边处最强，深入内部衰减到 0
        var pull = weight * strength;
        var moveX = dx * -pull; // 朝中心拉
        var moveY = dy * -pull;
        var index = (y * w + x) * 2;
        deltas[index] = moveX;
        deltas[index + 1] = moveY;
        var magnitude = Math.max(Math.abs(moveX), Math.abs(moveY));
        if (magnitude > maxDelta) maxDelta = magnitude;
      }
    }

    var scale = maxDelta > 0 ? maxDelta : 1;
    for (var i = 0, p = 0; p < deltas.length; i += 4, p += 2) {
      // 0.5 是"不动"，向两侧展开
      data[i] = Math.round((deltas[p] / scale + 0.5) * 255);
      data[i + 1] = Math.round((deltas[p + 1] / scale + 0.5) * 255);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL(), scale: scale / dpi };
  }

  /* ---------- SVG 滤镜 ---------- */

  function ensureSvg() {
    if (svg) return;
    var NS = "http://www.w3.org/2000/svg";
    svg = document.createElementNS(NS, "svg");
    svg.setAttribute("id", SVG_ID);
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;pointer-events:none";

    var defs = document.createElementNS(NS, "defs");
    var filter = document.createElementNS(NS, "filter");
    filter.setAttribute("id", FILTER_ID);
    filter.setAttribute("color-interpolation-filters", "sRGB");
    filter.setAttribute("x", "-20%");
    filter.setAttribute("y", "-20%");
    filter.setAttribute("width", "140%");
    filter.setAttribute("height", "140%");

    feBlur = document.createElementNS(NS, "feGaussianBlur");
    feBlur.setAttribute("in", "SourceGraphic");
    feBlur.setAttribute("result", "BLURRED");
    feBlur.setAttribute("stdDeviation", "0");

    feSat = document.createElementNS(NS, "feColorMatrix");
    feSat.setAttribute("type", "saturate");
    feSat.setAttribute("values", "1");

    feMap = document.createElementNS(NS, "feImage");
    feMap.setAttribute("x", "0");
    feMap.setAttribute("y", "0");
    feMap.setAttribute("preserveAspectRatio", "none");
    feMap.setAttribute("result", "MAP");

    feDisp = document.createElementNS(NS, "feDisplacementMap");
    feDisp.setAttribute("in", "BLURRED");
    feDisp.setAttribute("in2", "MAP");
    feDisp.setAttribute("xChannelSelector", "R");
    feDisp.setAttribute("yChannelSelector", "G");
    feDisp.setAttribute("scale", "0");

    filter.appendChild(feBlur);
    filter.appendChild(feSat);
    filter.appendChild(feMap);
    filter.appendChild(feDisp);
    defs.appendChild(filter);
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }

  function supportsBackdropUrl() {
    if (!window.CSS || !CSS.supports) return false;
    return CSS.supports("backdrop-filter", "url(#a)") || CSS.supports("-webkit-backdrop-filter", "url(#a)");
  }

  /* ---------- 应用到元素 ---------- */

  function applyTo(el) {
    ensureSvg();
    var rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return; // 还没布局

    var radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    var band = cssNumber("--lg-refract-band", 20);
    var strength = cssNumber("--lg-refract-strength", 0.12);
    var blur = cssNumber("--lg-blur", 14);
    var saturate = cssNumber("--lg-saturate", 175) / 100;

    // 尺寸按 4px 取整：滚动条出现之类造成的 1px 变化不值得重算贴图
    var signature =
      Math.round(rect.width / 4) * 4 +
      "x" +
      Math.round(rect.height / 4) * 4 +
      ":" +
      radius +
      ":" +
      band +
      ":" +
      strength +
      ":" +
      blur +
      ":" +
      saturate;
    if (signature !== current) {
      var map = buildMapData(rect.width, rect.height, radius, band, strength);
      feMap.setAttribute("width", String(rect.width));
      feMap.setAttribute("height", String(rect.height));
      feMap.setAttributeNS("http://www.w3.org/1999/xlink", "href", map.url);
      feMap.setAttribute("href", map.url);
      feDisp.setAttribute("scale", String(map.scale));
      feBlur.setAttribute("stdDeviation", String(blur));
      feSat.setAttribute("values", String(saturate));
      current = signature;
    }

    if (supportsBackdropUrl()) {
      // 模糊、饱和度、折射都在这个滤镜里完成（Chromium）
      el.style.webkitBackdropFilter = "url(#" + FILTER_ID + ")";
      el.style.backdropFilter = "url(#" + FILTER_ID + ")";
    }
  }

  function scan() {
    var nodes = document.querySelectorAll(".glass");
    for (var i = 0; i < nodes.length; i++) applyTo(nodes[i]);
  }

  var scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    /* 等 350ms 再扫：切页签时胶囊正在做 380ms 的形变动画，
       如果这时候重算位移贴图（要跑一遍 canvas 逐像素循环）会占住主线程、把动画卡掉。 */
    scanTimer = setTimeout(scan, 350);
  }

  function start() {
    if (!document.body) return;
    scan();
    window.addEventListener("resize", scheduleScan);
    if (window.MutationObserver) {
      // 只盯住 #app 的直接子节点：切页签会把底栏整个重建，这时要重新贴一次样式。
      // 不递归观察子树，避免每秒计时器刷新也触发扫描。
      var app = document.getElementById("app");
      if (app) new MutationObserver(scheduleScan).observe(app, { childList: true });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // 想手动调用也行（框架里可以只留这一段）
  window.LiquidGlass = { apply: applyTo, refresh: scheduleScan, scan: scan };
})();
