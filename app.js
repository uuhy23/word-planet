/* app.js — 单词星球：状态、界面、游戏、遗忘曲线复习、成长记录。
   数据只保存在浏览器 localStorage，不上传服务器。 */
(function () {
  "use strict";

  var STORAGE_KEY = "wordplanet.v1";
  var DAY = 24 * 60 * 60 * 1000;
  var INTERVALS = [1, 2, 4, 7, 15, 30, 60];
  var MASTER_STAGE = 6;

  var DEMO_WORDS = [
    { en: "apple", zh: "苹果" },
    { en: "book", zh: "书" },
    { en: "cat", zh: "猫" },
    { en: "dog", zh: "狗" },
    { en: "egg", zh: "鸡蛋" },
    { en: "fish", zh: "鱼" },
    { en: "girl", zh: "女孩" },
    { en: "hand", zh: "手" },
    { en: "ice", zh: "冰" },
    { en: "jump", zh: "跳" },
    { en: "kite", zh: "风筝" },
    { en: "lion", zh: "狮子" }
  ];

  /* ==================== 基础工具 ==================== */

  function uid(prefix) {
    return (prefix || "w") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseDayKey(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }

  function startOfDay(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function currentMonth(now) {
    var d = new Date(now);
    return { year: d.getFullYear(), month: d.getMonth() };
  }

  function shiftMonth(year, month, delta) {
    var d = new Date(year, month + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function tapFeedback(strong) {
    if (!navigator.vibrate || reduceMotion()) return;
    try {
      navigator.vibrate(strong ? 18 : 8);
    } catch (err) {
      /* ignore */
    }
  }

  var currentSpeakAudio = null;

  function speakSystem(word) {
    if (!("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      var voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
      var preferred =
        voices.find(function (voice) {
          return /Google US English|Microsoft (Aria|Jenny|Guy|Zira|David)|Samantha|Alex/i.test(voice.name || "");
        }) ||
        voices.find(function (voice) {
          return /^en-US/i.test(voice.lang || "");
        }) ||
        voices.find(function (voice) {
          return /^en/i.test(voice.lang || "");
        });
      var u = new SpeechSynthesisUtterance(word);
      if (preferred) u.voice = preferred;
      u.lang = preferred && preferred.lang ? preferred.lang : "en-US";
      u.rate = 0.9;
      u.pitch = 1;
      window.speechSynthesis.speak(u);
    } catch (err) {
      /* ignore */
    }
  }

  function speak(word) {
    if (!state.settings.sound) return;
    var text = String(word || "").trim();
    if (!text) return;
    try {
      if (currentSpeakAudio) {
        currentSpeakAudio.pause();
        currentSpeakAudio = null;
      }
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (err) {
      /* ignore */
    }
    var audio = new Audio("https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(text) + "&type=2");
    audio.preload = "auto";
    currentSpeakAudio = audio;
    var fallbackUsed = false;
    function fallback() {
      if (fallbackUsed) return;
      fallbackUsed = true;
      speakSystem(text);
    }
    audio.addEventListener("error", fallback);
    var playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") playPromise.catch(fallback);
  }

  var toastTimer = null;
  function toast(text) {
    var el = $("#toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 2600);
  }

  /* ==================== 状态 ==================== */

  function emptyState() {
    return {
      version: 1,
      theme: "light",
      view: "home",
      words: [],
      checkins: [],
      sessions: [],
      settings: {
        dailyNew: 8,
        reviewLimit: 30,
        sound: true
      },
      seeded: false
    };
  }

  function normalizeWord(raw) {
    raw = raw || {};
    var en = String(raw.en || "").trim().toLowerCase().replace(/\s+/g, " ");
    var zh = String(raw.zh || "").trim().replace(/\s+/g, " ");
    if (!en || !zh) return null;
    var stage = Number(raw.stage);
    stage = isFinite(stage) ? clamp(Math.round(stage), 0, MASTER_STAGE) : 0;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid("w"),
      en: en,
      zh: zh,
      phonetic: String(raw.phonetic || "").trim().slice(0, 60),
      source: typeof raw.source === "string" ? raw.source : "manual",
      createdAt: isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
      stage: stage,
      correct: Math.max(0, Number(raw.correct) || 0),
      wrong: Math.max(0, Number(raw.wrong) || 0),
      lastReviewAt: isFinite(Number(raw.lastReviewAt)) ? Number(raw.lastReviewAt) : null,
      nextReviewAt: isFinite(Number(raw.nextReviewAt)) ? Number(raw.nextReviewAt) : null,
      mastered: raw.mastered === true || stage >= MASTER_STAGE
    };
  }

  function load() {
    var s = emptyState();
    var raw = null;
    try {
      var text = window.localStorage.getItem(STORAGE_KEY);
      if (text) raw = JSON.parse(text);
    } catch (err) {
      console.warn("本地数据损坏，已忽略", err);
    }
    if (!raw || typeof raw !== "object") {
      s.words = DEMO_WORDS.map(function (item) {
        return normalizeWord({
          en: item.en,
          zh: item.zh,
          source: "demo",
          createdAt: Date.now() - Math.round(Math.random() * 300000)
        });
      });
      s.seeded = true;
      return s;
    }
    s.theme = ["light", "dark", "system"].indexOf(raw.theme) >= 0 ? raw.theme : "light";
    s.view = ["home", "review", "translate", "records", "profile"].indexOf(raw.view) >= 0 ? raw.view : "home";
    s.words = Array.isArray(raw.words)
      ? raw.words.map(normalizeWord).filter(function (w) {
          return !!w;
        })
      : [];
    s.checkins = Array.isArray(raw.checkins)
      ? raw.checkins.filter(function (k) {
          return typeof k === "string";
        })
      : [];
    s.sessions = Array.isArray(raw.sessions)
      ? raw.sessions.filter(function (r) {
          return r && typeof r.date === "string" && r.mode;
        })
      : [];
    s.settings = Object.assign({}, emptyState().settings, raw.settings || {});
    s.settings.dailyNew = clamp(Number(s.settings.dailyNew) || 8, 3, 30);
    s.settings.reviewLimit = clamp(Number(s.settings.reviewLimit) || 30, 5, 100);
    s.settings.sound = s.settings.sound !== false;
    s.seeded = raw.seeded === true;
    return s;
  }

  var state = load();

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.error("保存失败", err);
      toast("保存失败：浏览器存储空间可能已满");
      return false;
    }
  }

  if (!state.seeded && !state.words.length) {
    state.words = DEMO_WORDS.map(function (item) {
      return normalizeWord({ en: item.en, zh: item.zh, source: "demo", createdAt: Date.now() });
    });
    state.seeded = true;
    save();
  } else if (state.seeded || state.words.length) {
    save();
  }

  var systemTheme = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function resolvedTheme() {
    if (state.theme === "light" || state.theme === "dark") return state.theme;
    return systemTheme && systemTheme.matches ? "dark" : "light";
  }

  var ui = {
    monthCursor: null,
    yearCursor: null,
    recordsMode: "month",
    tabGeom: null,
    tabTimer: null,
    suppressTabClick: 0,
    lastViewKey: null,
    forceAnim: false,
    game: null,
    translate: {
      mode: "auto",
      input: "",
      result: "",
      status: "",
      from: "",
      to: "",
      loading: false,
      timer: null
    }
  };

  /* ==================== 单词与遗忘曲线 ==================== */

  function dueNewWords() {
    return state.words
      .filter(function (w) {
        return w.stage === 0;
      })
      .sort(function (a, b) {
        return a.createdAt - b.createdAt;
      });
  }

  function dueReviewWords() {
    var now = Date.now();
    return state.words
      .filter(function (w) {
        return w.stage > 0 && w.nextReviewAt && w.nextReviewAt <= now;
      })
      .sort(function (a, b) {
        return a.nextReviewAt - b.nextReviewAt;
      });
  }

  function masteredWords() {
    return state.words.filter(function (w) {
      return w.mastered || w.stage >= MASTER_STAGE;
    });
  }

  function getWord(id) {
    for (var i = 0; i < state.words.length; i++) {
      if (state.words[i].id === id) return state.words[i];
    }
    return null;
  }

  function addWords(pairs) {
    var added = [];
    pairs.forEach(function (pair) {
      var en = cleanEnglish(pair.en);
      var zh = cleanChinese(pair.zh);
      if (!en || !zh) return;
      var duplicate = state.words.some(function (w) {
        return w.en === en && w.zh === zh;
      });
      if (duplicate) return;
      var word = normalizeWord({
        en: en,
        zh: zh,
        phonetic: pair.phonetic || "",
        source: pair.source || "manual",
        createdAt: Date.now()
      });
      state.words.unshift(word);
      added.push(word);
    });
    save();
    return added.length;
  }

  function applyLearning(word, ok) {
    var now = Date.now();
    word.lastReviewAt = now;
    if (ok) {
      word.correct += 1;
      word.stage = 1;
      word.nextReviewAt = now + INTERVALS[0] * DAY;
      word.mastered = false;
    } else {
      word.wrong += 1;
      word.stage = 0;
      word.nextReviewAt = now + 10 * 60 * 1000;
      word.mastered = false;
    }
  }

  function applyReview(word, grade) {
    var now = Date.now();
    word.lastReviewAt = now;
    if (grade === "good") {
      word.correct += 1;
      word.stage = clamp(word.stage + 1, 1, MASTER_STAGE);
      word.nextReviewAt = now + INTERVALS[word.stage - 1] * DAY;
      word.mastered = word.stage >= MASTER_STAGE;
    } else if (grade === "hard") {
      word.correct += 1;
      word.stage = Math.max(1, word.stage);
      var interval = INTERVALS[word.stage - 1];
      word.nextReviewAt = now + Math.max(0.5, interval / 2) * DAY;
      word.mastered = word.stage >= MASTER_STAGE;
    } else {
      word.wrong += 1;
      word.stage = 1;
      word.nextReviewAt = now + 10 * 60 * 1000;
      word.mastered = false;
    }
  }

  function stageLabel(word) {
    if (word.mastered || word.stage >= MASTER_STAGE) return "已掌握";
    if (word.stage <= 0) return "新词";
    return "复习第 " + word.stage + " 级";
  }

  function addCheckin() {
    var key = dayKey(Date.now());
    if (state.checkins.indexOf(key) === -1) {
      state.checkins.push(key);
      state.checkins.sort();
    }
  }

  function checkinSet() {
    var set = {};
    state.checkins.forEach(function (key) {
      set[key] = true;
    });
    return set;
  }

  function streakDays() {
    var set = checkinSet();
    var cursor = startOfDay(Date.now());
    if (!set[dayKey(cursor)]) cursor -= DAY;
    var streak = 0;
    while (set[dayKey(cursor)]) {
      streak += 1;
      cursor -= DAY;
    }
    return streak;
  }

  function monthCells(year, month, now) {
    var set = checkinSet();
    var first = new Date(year, month, 1);
    var offset = (first.getDay() + 6) % 7;
    var days = new Date(year, month + 1, 0).getDate();
    var todayKey = dayKey(now);
    var cells = [];
    var i;
    for (i = 0; i < offset; i++) cells.push({ blank: true });
    for (i = 1; i <= days; i++) {
      var ts = new Date(year, month, i).getTime();
      var key = dayKey(ts);
      cells.push({
        day: i,
        key: key,
        done: !!set[key],
        future: key > todayKey,
        today: key === todayKey
      });
    }
    while (cells.length % 7 !== 0) cells.push({ blank: true });
    return cells;
  }

  function yearMonths(year, now) {
    var months = [];
    for (var m = 0; m < 12; m++) {
      months.push({
        month: m,
        label: m + 1 + "月",
        cells: monthCells(year, m, now)
      });
    }
    return months;
  }

  function sessionsByMonth(year, month) {
    return state.sessions.filter(function (r) {
      var d = parseDayKey(r.date);
      if (!d) return false;
      var x = new Date(d);
      return x.getFullYear() === year && x.getMonth() === month;
    });
  }

  function cleanEnglish(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[“”"'’‘]/g, "")
      .replace(/[.,;:!?()\[\]{}<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanChinese(value) {
    return String(value || "")
      .replace(/[“”"'’‘]/g, "")
      .replace(/([\u4e00-\u9fff])[\s\u3000]+(?=[\u4e00-\u9fff])/g, "$1")
      .replace(/\s+/g, " ")
      .replace(/^[，、；。·:：]+|[，、；。·:：]+$/g, "")
      .trim();
  }

  function condenseDefinition(value) {
    var text = cleanChinese(value)
      .replace(/^(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux)\.\s*/i, "")
      .replace(/【[^】]*】/g, "")
      .trim();
    var parts = text
      .split(/[；;]/)
      .map(function (part) {
        return part.trim();
      })
      .filter(Boolean);
    if (parts.length > 1) parts = parts.slice(0, 1);
    text = parts.join("；");
    text = text.replace(/（[^）]*[A-Za-z][^）]*）/g, "").replace(/\([^)]*[A-Za-z][^)]*\)/g, "").trim();
    if (text.length > 26) text = text.slice(0, 26).replace(/[，、；;:：\s]+$/g, "");
    return text;
  }

  /* ==================== 弹窗 ==================== */

  function openModal(html, opts) {
    opts = opts || {};
    var overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = '<div class="modal ' + (opts.size || "") + '">' + html + "</div>";
    document.body.appendChild(overlay);
    document.body.classList.add("modal-open");
    if (opts.backdropClose !== false) {
      overlay.addEventListener("mousedown", function (e) {
        if (e.target === overlay) closeModal(overlay);
      });
    }
    if (opts.onClose) overlay.__onClose = opts.onClose;
    return overlay;
  }

  function closeModal(overlay) {
    if (!overlay) return;
    if (typeof overlay.__cleanup === "function") overlay.__cleanup();
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (!$(".overlay")) document.body.classList.remove("modal-open");
  }

  function closeTopModal() {
    var all = $$(".overlay");
    if (all.length) closeModal(all[all.length - 1]);
  }

  function ensureTesseract(success, fail) {
    if (window.Tesseract) {
      success();
      return;
    }
    var urls = [
      "https://unpkg.com/tesseract.js@5/dist/tesseract.min.js",
      "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
      "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js"
    ];
    function loadNext(index) {
      if (index >= urls.length) {
        fail();
        return;
      }
      var script = document.createElement("script");
      script.src = urls[index];
      script.onload = success;
      script.onerror = function () {
        script.parentNode && script.parentNode.removeChild(script);
        loadNext(index + 1);
      };
      document.head.appendChild(script);
    }
    loadNext(0);
  }

  function parseWordPairs(text) {
    var lines = String(text || "")
      .replace(/\u00a0/g, " ")
      .split(/\r?\n/)
      .map(function (line) {
        return line.trim();
      });
    var out = [];
    var seen = {};
    function pushPair(en, zh) {
      var e = cleanEnglish(en);
      var z = cleanChinese(zh);
      if (!e || !z) return;
      if (!/^[a-zà-öø-ÿñ][a-zà-öø-ÿñ'’\- ]{0,45}$/.test(e)) return;
      if (!/[\u4e00-\u9fff]/.test(z)) return;
      if (/(单词表|词汇表|生词表|单元测试|unit\s*\d+)/i.test(z)) return;
      var key = e + "|" + z;
      if (seen[key]) return;
      seen[key] = true;
      out.push({ en: e, zh: z, phonetic: "" });
    }
    function isPosLine(line) {
      return /(?:^|[\s(（])(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux)\./i.test(line);
    }
    function extractZh(line) {
      var m = line.match(
        /(?:^|[\s(（])(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux)\.\s*([\u4e00-\u9fff][\u4e00-\u9fff，、；。·（）()\s]{0,60})/i
      );
      return m ? cleanChinese(m[1]) : "";
    }
    function extractHeadword(line) {
      var s = line
        .replace(/^\s*(?:[0-9]+|[一二三四五六七八九十]+)\s*[\.、\)）:：]\s*/, "")
        .trim();
      if (!s || isPosLine(s)) return "";
      var m = s.match(
        /^([A-Za-zÀ-ÖØ-öø-ÿñ][A-Za-zÀ-ÖØ-öø-ÿñ'’\-]*(?:\s+[A-Za-zÀ-ÖØ-öø-ÿñ][A-Za-zÀ-ÖØ-öø-ÿñ'’\-]*){0,2})/
      );
      if (!m) return "";
      var word = m[1].replace(/\s+/g, " ").trim();
      if (/^(a|an|the|this|that|it|he|she|they|we|you|i|is|are|was|were|be|to|of|in|on|for|with|and|or|but|if|as|at|by|from)$/i.test(word)) return "";
      if (word.length < 2) return "";
      return word;
    }
    for (var idx = 0; idx < lines.length; idx++) {
      var line = lines[idx];
      if (!line) continue;
      if (/\[(例|记|搭|派|同|反|考|辨|词根|词缀)\]/.test(line)) continue;
      if (line.length > 80) continue;
      var zh = extractZh(line);
      if (zh) {
        var inlineHead = extractHeadword(line);
        if (inlineHead) pushPair(inlineHead, zh);
        continue;
      }
      if (/[A-Za-zÀ-ÖØ-öø-ÿñ]/.test(line) && /[\u4e00-\u9fff]/.test(line) && line.length <= 48) {
        var enTokens = line.match(/[A-Za-zÀ-ÖØ-öø-ÿñ][A-Za-zÀ-ÖØ-öø-ÿñ'’\-]{0,35}/g) || [];
        var zhTokens = line.match(/[\u4e00-\u9fff][\u4e00-\u9fff，、；。·（）()\s]{0,35}/g) || [];
        if (enTokens.length && zhTokens.length) {
          var count = Math.min(enTokens.length, zhTokens.length);
          for (var k = 0; k < count; k++) pushPair(enTokens[k], zhTokens[k]);
          continue;
        }
      }
      var headword = extractHeadword(line);
      if (!headword) continue;
      if (line.indexOf("/") !== -1 || line.length <= 34) {
        for (var j = idx + 1; j < Math.min(lines.length, idx + 4); j++) {
          if (!lines[j]) continue;
          if (/\[(例|记|搭|派|同|反|考|辨|词根|词缀)\]/.test(lines[j])) continue;
          var nextZh = extractZh(lines[j]);
          if (nextZh) {
            pushPair(headword, nextZh);
            idx = j;
            break;
          }
        }
      }
    }
    if (!out.length) {
      lines.forEach(function (line) {
        var en = line.match(/[A-Za-zÀ-ÖØ-öø-ÿñ][A-Za-zÀ-ÖØ-öø-ÿñ'’\-]{0,35}/g) || [];
        var zh = line.match(/[\u4e00-\u9fff][\u4e00-\u9fff，、；。·（）()\s]{0,35}/g) || [];
        var n = Math.min(en.length, zh.length);
        for (var i = 0; i < n; i++) pushPair(en[i], zh[i]);
      });
    }
    return out;
  }

  function enhanceImage(img, crop, callback) {
    var sx = crop ? crop.sx : 0;
    var sy = crop ? crop.sy : 0;
    var sw = crop ? crop.sw : img.naturalWidth || img.width;
    var sh = crop ? crop.sh : img.naturalHeight || img.height;
    var scale = 1;
    if (sw < 1600) scale = 1600 / sw;
    else if (sw > 2400) scale = 2400 / sw;
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    var ctx = canvas.getContext("2d");
    ctx.filter = "grayscale(1) contrast(1.65) brightness(1.08)";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    callback(canvas);
  }

  function preprocessImage(file, callback) {
    var reader = new FileReader();
    reader.onerror = function () {
      callback(null);
    };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () {
        callback(null);
      };
      img.onload = function () {
        enhanceImage(img, null, callback);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function setupCrop(overlay) {
    var wrap = $("[data-crop-wrap]", overlay);
    var img = $("[data-album-preview]", overlay);
    var box = $("[data-crop-box]", overlay);
    var handle = $("[data-crop-handle]", overlay);
    var dragging = null;
    var start = null;
    var startRect = null;

    function area() {
      var wr = wrap.getBoundingClientRect();
      var ir = img.getBoundingClientRect();
      return { left: ir.left - wr.left, top: ir.top - wr.top, width: ir.width, height: ir.height };
    }

    function setRect(rect) {
      box.style.left = rect.left + "px";
      box.style.top = rect.top + "px";
      box.style.width = rect.width + "px";
      box.style.height = rect.height + "px";
    }

    function initBox() {
      var a = area();
      if (!a.width || !a.height) return;
      setRect({
        left: a.left + a.width * 0.08,
        top: a.top + a.height * 0.08,
        width: a.width * 0.84,
        height: a.height * 0.84
      });
      box.style.display = "block";
    }

    img.addEventListener("load", initBox);
    if (img.complete) initBox();

    function begin(event, mode) {
      event.preventDefault();
      dragging = mode;
      start = { x: event.clientX, y: event.clientY };
      startRect = { left: box.offsetLeft, top: box.offsetTop, width: box.offsetWidth, height: box.offsetHeight };
    }

    box.addEventListener("pointerdown", function (event) {
      if (event.target === handle) return;
      begin(event, "move");
      if (box.setPointerCapture) box.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointerdown", function (event) {
      event.stopPropagation();
      begin(event, "resize");
      if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
    });

    function move(event) {
      if (!dragging) return;
      var a = area();
      var dx = event.clientX - start.x;
      var dy = event.clientY - start.y;
      var rect;
      if (dragging === "move") {
        rect = {
          left: clamp(startRect.left + dx, a.left, a.left + a.width - startRect.width),
          top: clamp(startRect.top + dy, a.top, a.top + a.height - startRect.height),
          width: startRect.width,
          height: startRect.height
        };
      } else {
        rect = {
          left: startRect.left,
          top: startRect.top,
          width: clamp(startRect.width + dx, 70, a.left + a.width - startRect.left),
          height: clamp(startRect.height + dy, 46, a.top + a.height - startRect.top)
        };
      }
      setRect(rect);
    }

    function end() {
      dragging = null;
    }

    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);

    return {
      getCrop: function () {
        var a = area();
        if (!a.width || !a.height) return null;
        var rect = { left: box.offsetLeft, top: box.offsetTop, width: box.offsetWidth, height: box.offsetHeight };
        return {
          sx: ((rect.left - a.left) / a.width) * (img.naturalWidth || img.width),
          sy: ((rect.top - a.top) / a.height) * (img.naturalHeight || img.height),
          sw: (rect.width / a.width) * (img.naturalWidth || img.width),
          sh: (rect.height / a.height) * (img.naturalHeight || img.height)
        };
      }
    };
  }

  function candidateRowHTML(pair, index) {
    return (
      '<div class="candidate-row" data-pair-row="' + index + '">' +
      '<input type="text" data-pair-en value="' + esc(pair.en) + '" placeholder="英文" autocapitalize="off" spellcheck="false">' +
      '<input type="text" data-pair-zh value="' + esc(pair.zh) + '" placeholder="中文">' +
      '<button type="button" class="btn ghost small-btn" data-album="remove" data-index="' + index + '">删</button>' +
      "</div>"
    );
  }

  function renderCandidates(overlay, pairs, rawText) {
    overlay.__pairs = pairs;
    overlay.__raw = rawText || "";
    var list =
      pairs.map(candidateRowHTML).join("") ||
      '<p class="muted small">没有识别到成对的英文和中文，可以点“增加一行”手动补充。</p>';
    var area = $("[data-candidate-area]", overlay);
    area.innerHTML =
      '<div class="tip">识别到 <b>' +
      pairs.length +
      "</b> 组。识别结果可能有个别字母错误，确认或修改后再导入。</div>" +
      '<div class="candidate-list">' +
      list +
      "</div>" +
      '<div class="scan-actions"><button class="btn ghost small-btn" data-album="add-row">+ 增加一行</button></div>' +
      '<div class="modal-foot">' +
      '<button class="btn ghost" data-album="cancel">取消</button>' +
      '<button class="btn primary" data-album="import">导入 ' +
      pairs.length +
      " 个单词</button>" +
      "</div>";
  }

  function collectCandidates(overlay) {
    var pairs = [];
    $$("[data-pair-row]", overlay).forEach(function (row) {
      var en = $("[data-pair-en]", row).value;
      var zh = $("[data-pair-zh]", row).value;
      if (en.trim() || zh.trim()) pairs.push({ en: en, zh: zh, phonetic: "" });
    });
    return pairs;
  }

  function setOcrStatus(overlay, text, progress) {
    var status = $("[data-ocr-text]", overlay);
    var bar = $("[data-ocr-bar]", overlay);
    if (status) status.textContent = text;
    if (bar && progress != null) bar.style.width = Math.max(0, Math.min(100, progress)) + "%";
  }

  function runCloudOcr(canvas, overlay, success, fail) {
    canvas.toBlob(
      function (blob) {
        if (!blob) {
          fail();
          return;
        }
        var form = new FormData();
        form.append("apikey", "helloworld");
        form.append("language", "eng");
        form.append("isOverlayRequired", "false");
        form.append("scale", "true");
        form.append("file", blob, "word-list.jpg");
        fetch("https://api.ocr.space/parse/image", { method: "POST", body: form })
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            var text =
              data && data.ParsedResults && data.ParsedResults[0] && data.ParsedResults[0].ParsedText
                ? data.ParsedResults[0].ParsedText
                : "";
            if (text && !/^\s*$/.test(text)) success(text);
            else fail();
          })
          .catch(fail);
      },
      "image/jpeg",
      0.94
    );
  }

  function extractHeadwordsFromEnglishText(text) {
    var stop = {
      the: 1, and: 1, for: 1, with: 1, are: 1, was: 1, were: 1, will: 1, you: 1, your: 1,
      his: 1, her: 1, its: 1, our: 1, their: 1, from: 1, that: 1, this: 1, have: 1,
      has: 1, had: 1, not: 1, but: 1, can: 1, may: 1, could: 1, would: 1, should: 1,
      if: 1, a: 1, an: 1, of: 1, in: 1, on: 1, to: 1, at: 1, by: 1, as: 1, is: 1
    };
    var out = [];
    var seen = {};
    var source = String(text || "");
    source
      .split(/\r?\n/)
      .forEach(function (rawLine) {
        var line = rawLine
          .replace(/^\s*(?:[0-9]+|[一二三四五六七八九十]+)\s*[\.、\)）:：]\s*/, "")
          .replace(/^[\[\(（【][^\]\)）】]{0,12}[\]\)）】]\s*/, "")
          .trim();
        if (!line) return;
        if (/^[A-Z\s]+$/.test(line)) return;
        if (/[0-9]/.test(line)) return;
        var candidate = line.split("/")[0].trim();
        if (!candidate) return;
        if (!/^[A-Za-zÀ-ÖØ-öø-ÿñ][A-Za-zÀ-ÖØ-öø-ÿñ'’\-]*(?:\s+[A-Za-zÀ-ÖØ-öø-ÿñ][A-Za-zÀ-ÖØ-öø-ÿñ'’\-]*){0,1}$/.test(candidate)) return;
        if (candidate.indexOf("'") !== -1) return;
        var lower = candidate.toLowerCase();
        if (stop[lower]) return;
        if (lower.length < 3 || lower.length > 24) return;
        if (seen[lower]) return;
        seen[lower] = true;
        out.push(candidate);
      });
    function key(value) {
      return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9' ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    var unique = [];
    var uniqueSeen = {};
    out.forEach(function (word) {
      var k = key(word);
      if (!k || uniqueSeen[k]) return;
      uniqueSeen[k] = true;
      unique.push({ word: word, count: (source.match(new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi")) || []).length });
    });
    unique.sort(function (a, b) {
      return b.count - a.count;
    });
    var repeated = unique.filter(function (item) {
      return item.count >= 2;
    });
    var picked = unique.length >= 6 && repeated.length >= 4 ? repeated : unique;
    return picked.map(function (item) {
      return item.word;
    }).slice(0, 60);
  }

  function translateHeadwords(headwords, overlay, done) {
    if (!headwords.length) {
      done([]);
      return;
    }
    var results = new Array(headwords.length);
    var cursor = 0;
    var active = 0;
    function pump() {
      while (active < 3 && cursor < headwords.length) {
        (function (index) {
          active += 1;
          var word = headwords[index];
          setOcrStatus(overlay, "正在翻译单词 " + index + 1 + "/" + headwords.length, 88);
          translateText(word, "en", "zh", function (text) {
            var zh = condenseDefinition(text || "");
            var same =
              zh &&
              zh.toLowerCase().replace(/\s+/g, " ") === word.toLowerCase().replace(/\s+/g, " ");
            results[index] =
              zh && !same && /[\u4e00-\u9fff]/.test(zh) ? { en: word, zh: zh, phonetic: "" } : null;
            active -= 1;
            if (cursor >= headwords.length && active === 0) done(results);
            else pump();
          });
        })(cursor++);
      }
    }
    pump();
  }

  function runAlbumOcr(canvas, overlay) {
    setOcrStatus(overlay, "正在识别…", 8);
    var fakeProgress = 8;
    var fakeTimer = setInterval(function () {
      fakeProgress = Math.min(88, fakeProgress + 5);
      setOcrStatus(overlay, "正在识别… " + Math.round(fakeProgress) + "%", fakeProgress);
    }, 520);
    function finish(pairs, rawText) {
      clearInterval(fakeTimer);
      var seen = {};
      var unique = [];
      (pairs || []).forEach(function (pair) {
        if (!pair || !pair.en) return;
        var key = pair.en
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9' ]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!key || seen[key]) return;
        seen[key] = true;
        unique.push(pair);
      });
      setOcrStatus(overlay, "识别完成，请确认单词", 100);
      renderCandidates(overlay, unique, rawText || "");
      toast(unique.length ? "识别完成，可以修改后导入" : "没有识别到成对单词，可以手动补充");
    }
    function tesseractFallback() {
      ensureTesseract(
        function () {
          window.Tesseract.recognize(canvas, "eng+chi_sim", {
            workerPath: "https://unpkg.com/tesseract.js@5.1.1/dist/worker.min.js",
            corePath: "https://unpkg.com/tesseract.js-core@5.1.0",
            langPath: "https://tessdata.projectnaptha.com/4.0.0",
            logger: function (m) {
              if (m.status === "recognizing text") {
                setOcrStatus(overlay, "识别中 " + Math.round(m.progress * 100) + "%", 8 + m.progress * 90);
              }
            }
          })
            .then(function (result) {
              var text = result && result.data ? result.data.text : "";
              finish(parseWordPairs(text), text);
            })
            .catch(function () {
              clearInterval(fakeTimer);
              setOcrStatus(overlay, "识别失败，建议框选一条单词再试", 100);
              toast("识别失败，试试只框住一条单词");
            });
        },
        function () {
          clearInterval(fakeTimer);
          setOcrStatus(overlay, "识别组件加载失败，请检查网络后重试", 100);
          toast("识别组件加载失败");
        }
      );
    }
    runCloudOcr(
      canvas,
      overlay,
      function (text) {
        var headwords = extractHeadwordsFromEnglishText(text);
        if (headwords.length) {
          clearInterval(fakeTimer);
          translateHeadwords(headwords, overlay, function (pairs) {
            finish(pairs, text);
          });
        } else {
          clearInterval(fakeTimer);
          tesseractFallback();
        }
      },
      function () {
        clearInterval(fakeTimer);
        tesseractFallback();
      }
    );
  }

  function processAlbumImage(file) {
    var overlay = openModal(
      "<h2>🖼 相册识词</h2>" +
        '<p class="muted small">拖动方框只框住单词表区域，识别会准确很多。识别后还可以逐条修改。</p>' +
        '<div class="crop-wrap" data-crop-wrap><img class="crop-image" data-album-preview alt=""><div class="crop-box" data-crop-box><span class="crop-handle" data-crop-handle></span></div></div>' +
        '<div class="scan-actions">' +
        '<button class="btn primary" data-album="recognize-crop">识别框选区域</button>' +
        '<button class="btn" data-album="recognize-full">识别整张</button>' +
        '<button class="btn ghost" data-album="reselect">重新选择</button>' +
        "</div>" +
        '<div class="ocr-status"><span data-ocr-text>拖动方框选择要识别的区域</span><div class="ocr-bar"><span data-ocr-bar></span></div></div>' +
        '<div data-candidate-area></div>',
      {}
    );
    var preview = $("[data-album-preview]", overlay);
    var objectUrl = URL.createObjectURL(file);
    preview.src = objectUrl;
    overlay.__cleanup = function () {
      URL.revokeObjectURL(objectUrl);
    };
    var crop = setupCrop(overlay);
    function recognize(cropRect) {
      if (!preview.naturalWidth) {
        toast("图片还没加载好");
        return;
      }
      enhanceImage(preview, cropRect, function (canvas) {
        runAlbumOcr(canvas, overlay);
      });
    }
    overlay.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-album]");
      if (!btn) return;
      var action = btn.getAttribute("data-album");
      if (action === "cancel") {
        closeModal(overlay);
        return;
      }
      if (action === "reselect") {
        closeModal(overlay);
        openAlbumImport();
        return;
      }
      if (action === "recognize-full") {
        recognize(null);
        return;
      }
      if (action === "recognize-crop") {
        recognize(crop.getCrop());
        return;
      }
      if (action === "add-row") {
        var pairs = overlay.__pairs || [];
        pairs.push({ en: "", zh: "", phonetic: "" });
        renderCandidates(overlay, pairs, overlay.__raw || "");
        return;
      }
      if (action === "remove") {
        var list = overlay.__pairs || [];
        list.splice(Number(btn.getAttribute("data-index")), 1);
        renderCandidates(overlay, list, overlay.__raw || "");
        return;
      }
      if (action === "import") {
        var toAdd = collectCandidates(overlay).map(function (p) {
          p.source = "album";
          return p;
        });
        var count = addWords(toAdd);
        closeModal(overlay);
        toast(count ? "已从相册导入 " + count + " 个单词 🎉" : "没有可导入的新单词");
        render();
      }
    });
  }

  function openAlbumImport() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (input.parentNode) input.parentNode.removeChild(input);
      if (file) processAlbumImage(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  function openManualAdd() {
    var overlay = openModal(
      "<h2>✏️ 手动添加单词</h2>" +
        '<p class="muted small">输入中文会自动填英文，输入英文会自动填中文，两边都可以手动修改。</p>' +
        '<div class="form">' +
        '<label class="field"><span>英文</span><input type="text" data-manual-en maxlength="60" placeholder="apple" autocapitalize="off" spellcheck="false"></label>' +
        '<label class="field"><span>中文</span><input type="text" data-manual-zh maxlength="80" placeholder="苹果"></label>' +
        '<em class="hint" data-manual-status>输入中文或英文会自动翻译</em>' +
        '<label class="field"><span>音标（可选）</span><input type="text" data-manual-phonetic maxlength="60" placeholder="/ˈæpl/"></label>' +
        "</div>" +
        '<div class="modal-foot"><button class="btn ghost" data-manual="cancel">取消</button><button class="btn primary" data-manual="add">添加</button></div>',
      {}
    );
    var enInput = $("[data-manual-en]", overlay);
    var zhInput = $("[data-manual-zh]", overlay);
    var statusEl = $("[data-manual-status]", overlay);
    var autoTimer = null;

    function autoFill(from) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () {
        var value = from === "en" ? enInput.value.trim() : zhInput.value.trim();
        if (!value) {
          statusEl.textContent = "输入中文或英文会自动翻译";
          return;
        }
        statusEl.textContent = "翻译中…";
        translateText(value, from, from === "en" ? "zh" : "en", function (text) {
          if (!text) {
            statusEl.textContent = "没有查到翻译，请手动填写另一边";
            return;
          }
          if (from === "en") zhInput.value = condenseDefinition(text);
          else enInput.value = text;
          statusEl.textContent = "已自动填写，可以手动修改";
        });
      }, 620);
    }

    enInput.addEventListener("input", function () {
      autoFill("en");
    });
    zhInput.addEventListener("input", function () {
      autoFill("zh");
    });

    overlay.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-manual]");
      if (!btn) return;
      if (btn.getAttribute("data-manual") === "cancel") {
        closeModal(overlay);
        return;
      }
      var en = $("[data-manual-en]", overlay).value;
      var zh = $("[data-manual-zh]", overlay).value;
      var phonetic = $("[data-manual-phonetic]", overlay).value;
      var count = addWords([{ en: en, zh: zh, phonetic: phonetic, source: "manual" }]);
      closeModal(overlay);
      toast(count ? "已添加 🎉" : "英文和中文都要填写，且不能重复");
      render();
    });
  }

  function openWordManager() {
    var words = state.words;
    var html =
      "<h2>📚 我的词库</h2>" +
      '<p class="muted small">共 ' +
      words.length +
      " 个单词。词库会参与每天的新词学习和复习计划。</p>";
    if (!words.length) {
      html += '<div class="empty-cartoon"><span class="big">🪄</span><p class="muted">还没有单词，先去手动添加吧。</p></div>';
    } else {
      html += '<div class="list">';
      words.slice(0, 120).forEach(function (word) {
        html +=
          '<div class="word-row">' +
          '<button class="row-main" data-word-edit="' + word.id + '" style="flex:1;border:0;background:transparent;color:inherit;text-align:left;padding:0">' +
          '<span class="word-en">' + esc(word.en) + "</span> · " +
          '<span class="word-zh">' + esc(word.zh) + "</span>" +
          "</button>" +
          '<span class="word-stage">' + stageLabel(word) + "</span>" +
          '<button class="btn ghost small-btn" data-word-del="' + word.id + '">删</button>' +
          "</div>";
      });
      html += "</div>";
      if (words.length > 120) html += '<p class="muted small">只显示前 120 个，可在设置里导出全部。</p>';
    }
    html +=
      '<div class="modal-foot"><button class="btn ghost" data-words="close">关闭</button><button class="btn primary" data-words="add">添加单词</button></div>';
    var overlay = openModal(html, {});

    overlay.addEventListener("click", function (e) {
      var del = e.target.closest("[data-word-del]");
      if (del) {
        var id = del.getAttribute("data-word-del");
        state.words = state.words.filter(function (w) {
          return w.id !== id;
        });
        save();
        closeModal(overlay);
        openWordManager();
        toast("已删除");
        return;
      }
      var edit = e.target.closest("[data-word-edit]");
      if (edit) {
        closeModal(overlay);
        openEditWord(edit.getAttribute("data-word-edit"));
        return;
      }
      var act = e.target.closest("[data-words]");
      if (!act) return;
      if (act.getAttribute("data-words") === "close") {
        closeModal(overlay);
      } else if (act.getAttribute("data-words") === "add") {
        closeModal(overlay);
        openManualAdd();
      }
    });
  }

  function openEditWord(id) {
    var word = getWord(id);
    if (!word) return;
    var overlay = openModal(
      "<h2>✏️ 编辑单词</h2>" +
        '<div class="form">' +
        '<label class="field"><span>英文</span><input type="text" data-edit-en value="' + esc(word.en) + '" autocapitalize="off" spellcheck="false"></label>' +
        '<label class="field"><span>中文</span><input type="text" data-edit-zh value="' + esc(word.zh) + '"></label>' +
        '<label class="field"><span>音标</span><input type="text" data-edit-phonetic value="' + esc(word.phonetic) + '"></label>' +
        "</div>" +
        '<div class="modal-foot"><button class="btn ghost" data-edit="cancel">取消</button><button class="btn primary" data-edit="save">保存</button></div>',
      {}
    );
    overlay.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-edit]");
      if (!btn) return;
      if (btn.getAttribute("data-edit") === "cancel") {
        closeModal(overlay);
        openWordManager();
        return;
      }
      var en = cleanEnglish($("[data-edit-en]", overlay).value);
      var zh = cleanChinese($("[data-edit-zh]", overlay).value);
      if (!en || !zh) {
        toast("英文和中文都要填写");
        return;
      }
      word.en = en;
      word.zh = zh;
      word.phonetic = $("[data-edit-phonetic]", overlay).value.trim();
      save();
      closeModal(overlay);
      openWordManager();
      toast("已保存");
    });
  }

  /* ==================== 游戏会话 ==================== */

  var MODE_LABELS = {
    balloon: "🎈 气球配对",
    spell: "🧩 拼写闯关",
    dictation: "🎧 听写默写",
    review: "⏳ 智能复习"
  };

  function pickWords(list, count) {
    return shuffle(list).slice(0, Math.max(1, Math.min(count, list.length)));
  }

  function openWordPicker(mode) {
    if (!state.words.length) {
      toast("词库还是空的，先添加几个单词吧");
      return;
    }
    var selected = {};
    var preselect = dueNewWords().slice(0, state.settings.dailyNew);
    if (!preselect.length) preselect = state.words.slice(0, Math.min(8, state.words.length));
    preselect.forEach(function (word) {
      selected[word.id] = true;
    });
    var overlay = openModal(
      "<h2>" +
        (mode === "balloon" ? "🎈 气球配对" : "🧩 拼写闯关") +
        "</h2>" +
        '<p class="muted small">从词库里选择这次要练的单词，选好后开始。</p>' +
        '<label class="field"><span>搜索单词</span><input type="text" data-pick-search placeholder="输入英文或中文"></label>' +
        '<div class="list pick-list" data-pick-list></div>' +
        '<div class="actions" style="margin-top:12px">' +
        '<button class="btn ghost small-btn" data-picker="all">全选</button>' +
        '<button class="btn ghost small-btn" data-picker="none">清空</button>' +
        "</div>" +
        '<div class="modal-foot">' +
        '<button class="btn ghost" data-picker="cancel">取消</button>' +
        '<button class="btn primary" data-picker="start">开始学习</button>' +
        "</div>",
      {}
    );
    var listEl = $("[data-pick-list]", overlay);
    var startBtn = $('[data-picker="start"]', overlay);
    var searchEl = $("[data-pick-search]", overlay);

    function sortedWords() {
      return state.words.slice().sort(function (a, b) {
        if (a.stage === 0 && b.stage !== 0) return -1;
        if (b.stage === 0 && a.stage !== 0) return 1;
        return (a.nextReviewAt || 0) - (b.nextReviewAt || 0);
      });
    }

    function visibleWords() {
      var q = (searchEl.value || "").trim().toLowerCase();
      var list = sortedWords();
      if (!q) return list;
      return list.filter(function (word) {
        return word.en.toLowerCase().indexOf(q) !== -1 || word.zh.toLowerCase().indexOf(q) !== -1;
      });
    }

    function updateStart() {
      var count = Object.keys(selected).filter(function (id) {
        return selected[id];
      }).length;
      startBtn.textContent = count ? "开始学习（" + count + "）" : "开始学习";
    }

    function renderPicker() {
      var words = visibleWords();
      listEl.innerHTML =
        words
          .map(function (word) {
            return (
              '<button type="button" class="pick-row' +
              (selected[word.id] ? " selected" : "") +
              '" data-pick-word="' +
              word.id +
              '"><span class="pick-check">✓</span><span class="pick-text"><b>' +
              esc(word.en) +
              "</b><small>" +
              esc(word.zh) +
              '</small></span><span class="word-stage">' +
              stageLabel(word) +
              "</span></button>"
            );
          })
          .join("") || '<p class="muted small" style="padding:14px">没有找到匹配的单词</p>';
      updateStart();
    }

    renderPicker();
    overlay.addEventListener("input", function (e) {
      if (e.target === searchEl) renderPicker();
    });
    overlay.addEventListener("click", function (e) {
      var row = e.target.closest("[data-pick-word]");
      if (row) {
        var id = row.getAttribute("data-pick-word");
        selected[id] = !selected[id];
        renderPicker();
        return;
      }
      var btn = e.target.closest("[data-picker]");
      if (!btn) return;
      var action = btn.getAttribute("data-picker");
      if (action === "cancel") {
        closeModal(overlay);
        return;
      }
      if (action === "all") {
        visibleWords().forEach(function (word) {
          selected[word.id] = true;
        });
        renderPicker();
        return;
      }
      if (action === "none") {
        Object.keys(selected).forEach(function (id) {
          selected[id] = false;
        });
        renderPicker();
        return;
      }
      if (action === "start") {
        var chosen = state.words.filter(function (word) {
          return selected[word.id];
        });
        if (!chosen.length) {
          toast("至少选 1 个单词");
          return;
        }
        if (mode === "balloon" && chosen.length < 2) {
          toast("气球配对至少选 2 个单词");
          return;
        }
        closeModal(overlay);
        startMode(mode, chosen);
      }
    });
  }

  function startMode(mode, customWords) {
    if (!state.words.length) {
      toast("词库还是空的，先添加几个单词吧");
      return;
    }
    var words;
    var source;
    if (customWords && customWords.length) {
      words = customWords.slice();
      source = "custom";
    } else if (mode === "review") {
      var due = dueReviewWords();
      if (!due.length) {
        toast("今天没有到期的复习，可以先学新词");
        return;
      }
      words = pickWords(due, state.settings.reviewLimit);
      source = "review";
    } else {
      var fresh = dueNewWords();
      if (fresh.length) {
        words = pickWords(fresh, state.settings.dailyNew);
        source = "new";
      } else {
        var review = dueReviewWords();
        if (review.length) {
          words = pickWords(review, Math.min(8, review.length));
          source = "review";
        } else {
          var mastered = masteredWords();
          if (!mastered.length) {
            toast("词库还没有单词，先添加几个单词");
            return;
          }
          words = pickWords(mastered, 6);
          source = "practice";
        }
      }
    }

    ui.game = {
      mode: mode,
      source: source,
      words: words,
      index: 0,
      score: 0,
      correct: 0,
      wrong: 0,
      results: [],
      finished: false,
      startedAt: Date.now(),
      answer: "",
      tries: 0,
      step: 1,
      revealed: false,
      feedback: null,
      lock: false,
      cards: [],
      selectedEn: null,
      selectedZh: null,
      matched: 0,
      roundWords: [],
      options: [],
      used: [],
      missing: 0
    };

    state.view = "game";
    if (mode === "balloon") buildBalloonRound();
    else if (mode === "spell") buildSpellStep();
    else if (mode === "dictation") buildDictationStep();
    else ui.game.revealed = false;
    render(true);
  }

  function startPractice() {
    var mastered = masteredWords();
    if (!mastered.length) {
      toast("还没有已掌握的单词");
      return;
    }
    ui.game = {
      mode: "dictation",
      source: "practice",
      words: pickWords(mastered, 6),
      index: 0,
      score: 0,
      correct: 0,
      wrong: 0,
      results: [],
      finished: false,
      startedAt: Date.now(),
      answer: "",
      tries: 0,
      step: 1,
      revealed: false,
      feedback: null,
      lock: false,
      cards: [],
      selectedEn: null,
      selectedZh: null,
      matched: 0,
      roundWords: [],
      options: [],
      used: [],
      missing: 0
    };
    state.view = "game";
    buildDictationStep();
    render(true);
  }

  function buildBalloonRound() {
    var g = ui.game;
    var round = g.words.slice(g.index, g.index + 3);
    if (!round.length) {
      finishGame();
      return;
    }
    var cards = [];
    round.forEach(function (w) {
      cards.push({ wordId: w.id, type: "en", text: w.en, matched: false, exploding: false });
      cards.push({ wordId: w.id, type: "zh", text: w.zh, matched: false, exploding: false });
    });
    g.cards = shuffle(cards);
    g.roundWords = round;
    g.matched = 0;
    g.selectedEn = null;
    g.selectedZh = null;
    g.lock = false;
    g.feedback = null;
  }

  function tapBalloon(index) {
    var g = ui.game;
    if (!g || g.lock || g.finished) return;
    var card = g.cards[index];
    if (!card || card.matched) return;
    if (card.type === "en") {
      if (g.selectedEn === index) {
        g.selectedEn = null;
        render();
        return;
      }
      g.selectedEn = index;
      if (g.selectedZh !== null) evaluateBalloon();
      else render();
    } else {
      if (g.selectedZh === index) {
        g.selectedZh = null;
        render();
        return;
      }
      g.selectedZh = index;
      if (g.selectedEn !== null) evaluateBalloon();
      else render();
    }
  }

  function evaluateBalloon() {
    var g = ui.game;
    var enCard = g.cards[g.selectedEn];
    var zhCard = g.cards[g.selectedZh];
    if (enCard.wordId === zhCard.wordId) {
      g.lock = true;
      g.feedback = "good";
      enCard.exploding = true;
      zhCard.exploding = true;
      render();
      var word = getWord(enCard.wordId);
      if (word) speak(word.en);
      setTimeout(function () {
        enCard.exploding = false;
        zhCard.exploding = false;
        enCard.matched = true;
        zhCard.matched = true;
        g.matched += 1;
        g.selectedEn = null;
        g.selectedZh = null;
        g.lock = false;
        g.feedback = null;
        if (g.matched === g.roundWords.length) finishBalloonRound();
        else render();
      }, 560);
    } else {
      g.lock = true;
      g.feedback = "bad";
      render();
      tapFeedback();
      setTimeout(function () {
        g.selectedEn = null;
        g.selectedZh = null;
        g.lock = false;
        g.feedback = null;
        render();
      }, 420);
    }
  }

  function finishBalloonRound() {
    var g = ui.game;
    g.roundWords.forEach(function (word) {
      g.results.push({ word: word, ok: true });
    });
    g.correct += g.roundWords.length;
    g.score += g.roundWords.length * 10;
    g.index += g.roundWords.length;
    if (g.index >= g.words.length) finishGame();
    else {
      buildBalloonRound();
      render();
    }
  }

  function buildSpellStep() {
    var g = ui.game;
    g.step = 1;
    g.tries = 0;
    g.answer = "";
    g.revealed = false;
    g.feedback = null;
  }

  function submitSpell(value) {
    var g = ui.game;
    if (!g || g.finished) return;
    var word = g.words[g.index];
    var target = word.en.toLowerCase();
    var val = cleanEnglish(value);
    if (val === target) {
      finishWord(true);
      return;
    }
    g.tries += 1;
    if (g.tries >= 2) {
      g.revealed = true;
      render();
      setTimeout(function () {
        finishWord(false);
      }, 950);
    } else {
      g.feedback = "bad";
      render();
      setTimeout(function () {
        g.feedback = null;
        render();
      }, 460);
    }
  }

  function buildDictationStep() {
    var g = ui.game;
    g.step = "listen";
    g.tries = 0;
    g.revealed = false;
    g.feedback = null;
  }

  function submitDictation(value) {
    var g = ui.game;
    if (!g || g.finished) return;
    var word = g.words[g.index];
    var target = word.en.toLowerCase();
    var val = cleanEnglish(value);
    if (g.step === "listen") {
      if (val === target) {
        finishWord(true);
      } else {
        g.tries += 1;
        if (g.tries >= 2) {
          g.step = "write";
          g.tries = 0;
          g.revealed = false;
          g.feedback = null;
          render();
        } else {
          g.feedback = "bad";
          render();
          setTimeout(function () {
            g.feedback = null;
            render();
          }, 460);
        }
      }
    } else if (g.step === "write") {
      if (val === target) {
        finishWord(true);
      } else {
        g.tries += 1;
        if (g.tries >= 2) {
          g.revealed = true;
          render();
          setTimeout(function () {
            finishWord(false);
          }, 950);
        } else {
          g.feedback = "bad";
          render();
          setTimeout(function () {
            g.feedback = null;
            render();
          }, 460);
        }
      }
    }
  }

  function finishWord(ok) {
    var g = ui.game;
    var word = g.words[g.index];
    g.results.push({ word: word, ok: ok });
    if (ok) {
      g.correct += 1;
      g.score += Math.max(8, 30 - g.tries * 4);
    } else {
      g.wrong += 1;
    }
    g.index += 1;
    if (g.index >= g.words.length) finishGame();
    else {
      if (g.mode === "spell") buildSpellStep();
      else buildDictationStep();
      render();
    }
  }

  function gradeReview(grade) {
    var g = ui.game;
    if (!g || g.finished) return;
    var word = g.words[g.index];
    applyReview(word, grade);
    g.results.push({ word: word, ok: grade !== "again" });
    if (grade === "again") g.wrong += 1;
    else {
      g.correct += 1;
      g.score += grade === "good" ? 20 : 12;
    }
    g.index += 1;
    if (g.index >= g.words.length) finishGame();
    else {
      g.revealed = false;
      render();
    }
  }

  function finishGame() {
    var g = ui.game;
    if (!g || g.finished) return;
    g.total = g.results.length;
    g.correct = g.results.filter(function (r) {
      return r.ok;
    }).length;
    g.wrong = g.results.length - g.correct;
    g.score = Math.max(g.score, g.correct * 10);

    if (g.source === "new") {
      g.results.forEach(function (r) {
        applyLearning(r.word, r.ok);
      });
    } else if (g.source === "custom") {
      g.results.forEach(function (r) {
        var now = Date.now();
        if (r.word.stage === 0) {
          applyLearning(r.word, r.ok);
        } else if (r.ok) {
          r.word.correct += 1;
          r.word.lastReviewAt = now;
        } else {
          r.word.wrong += 1;
          r.word.lastReviewAt = now;
        }
      });
    }

    var now = Date.now();
    state.sessions.unshift({
      id: uid("s"),
      date: dayKey(now),
      ts: now,
      mode: g.mode,
      source: g.source,
      total: g.results.length,
      correct: g.correct,
      wrong: g.wrong
    });
    addCheckin();
    save();
    g.finished = true;
    render();
  }

  function quitGame() {
    ui.game = null;
    state.view = "home";
    render(true);
  }

  /* ==================== 翻译 ==================== */

  function decodeEntities(value) {
    var el = document.createElement("textarea");
    el.innerHTML = String(value || "");
    return el.value;
  }

  function lookupLocalTranslation(text, from) {
    var value = String(text || "").trim();
    if (!value) return "";
    var lower = value.toLowerCase();
    for (var i = 0; i < state.words.length; i++) {
      var word = state.words[i];
      if (from === "en" && word.en.toLowerCase() === lower) return word.zh;
      if (from === "zh" && word.zh === value) return word.en;
    }
    return "";
  }

  var youdaoSeq = 0;
  function youdaoLookup(text, callback) {
    var value = String(text || "").trim();
    if (!value) {
      callback("");
      return;
    }
    var name = "__yd_cb_" + Date.now().toString(36) + "_" + ++youdaoSeq;
    var script = document.createElement("script");
    var timer = setTimeout(function () {
      cleanup();
      callback("");
    }, 7000);
    function cleanup() {
      clearTimeout(timer);
      if (script.parentNode) script.parentNode.removeChild(script);
      try {
        delete window[name];
      } catch (err) {
        window[name] = undefined;
      }
    }
    window[name] = function (data) {
      var explain =
        data &&
        data.data &&
        data.data.entries &&
        data.data.entries[0] &&
        data.data.entries[0].explain
          ? data.data.entries[0].explain
          : "";
      cleanup();
      callback(explain);
    };
    script.onerror = function () {
      cleanup();
      callback("");
    };
    script.src =
      "https://dict.youdao.com/suggest?q=" +
      encodeURIComponent(value) +
      "&num=1&doctype=json&callback=" +
      name;
    document.head.appendChild(script);
  }

  function translateText(text, from, to, callback) {
    var value = String(text || "").trim();
    if (!value) {
      callback("", "empty");
      return;
    }
    var local = lookupLocalTranslation(value, from);
    if (local) {
      callback(local, "local");
      return;
    }
    function myMemory() {
      var pair = from === "zh" ? "zh-CN|en" : "en|zh-CN";
      var url =
        "https://api.mymemory.translated.net/get?q=" +
        encodeURIComponent(value.slice(0, 220)) +
        "&langpair=" +
        encodeURIComponent(pair);
      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
      }, 9000);
      fetch(url, controller ? { signal: controller.signal } : {})
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          clearTimeout(timer);
          var translated =
            data && data.responseData && data.responseData.translatedText
              ? decodeEntities(data.responseData.translatedText).trim()
              : "";
          if (!translated || /MYMEMORY WARNING/i.test(translated)) {
            callback("", "error");
            return;
          }
          if (to === "en") translated = translated.toLowerCase().replace(/\s+/g, " ");
          callback(translated, "online");
        })
        .catch(function () {
          clearTimeout(timer);
          callback("", "error");
        });
    }
    if (from === "en" && to === "zh" && /^[A-Za-zÀ-ÖØ-öø-ÿñ][A-Za-zÀ-ÖØ-öø-ÿñ'’\- ]{0,40}$/.test(value)) {
      youdaoLookup(value, function (explain) {
        var zh = cleanChinese(explain || "").replace(/^(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux)\.\s*/i, "");
        if (zh && /[\u4e00-\u9fff]/.test(zh)) callback(zh, "youdao");
        else myMemory();
      });
    } else {
      myMemory();
    }
  }

  function translatePanelHTML(t) {
    if (t.loading) {
      return '<div class="tip"><span class="muted">翻译中，请稍等…</span></div>';
    }
    if (t.status === "error") {
      return '<div class="tip">没有查到翻译。可以换个说法，或者手动填写。</div>';
    }
    if (t.result) {
      return (
        '<div class="translate-result">' +
        '<span class="game-label">翻译结果</span>' +
        '<div class="zh-big">' +
        esc(t.result) +
        "</div>" +
        '<div class="actions">' +
        '<button class="btn ghost small-btn" data-act="translate-speak">🔊 朗读</button>' +
        '<button class="btn primary small-btn" data-act="translate-add">加入词库</button>' +
        "</div></div>"
      );
    }
    return '<p class="muted small">输入中文会自动翻译成英文，输入英文会自动翻译成中文。</p>';
  }

  function updateTranslatePanel() {
    var panel = $("[data-translate-panel]");
    if (panel) panel.innerHTML = translatePanelHTML(ui.translate);
  }

  function runTranslation() {
    var input = $("[data-translate-input]");
    var value = (input ? input.value : ui.translate.input || "").trim();
    ui.translate.input = value;
    if (!value) {
      ui.translate.result = "";
      ui.translate.status = "";
      ui.translate.loading = false;
      updateTranslatePanel();
      return;
    }
    var from;
    if (ui.translate.mode === "zh-en") from = "zh";
    else if (ui.translate.mode === "en-zh") from = "en";
    else from = /[\u4e00-\u9fff]/.test(value) ? "zh" : "en";
    var to = from === "zh" ? "en" : "zh";
    ui.translate.from = from;
    ui.translate.to = to;
    ui.translate.loading = true;
    ui.translate.status = "loading";
    ui.translate.result = "";
    updateTranslatePanel();
    translateText(value, from, to, function (text) {
      ui.translate.loading = false;
      if (text) {
        ui.translate.result = text;
        ui.translate.status = "done";
      } else {
        ui.translate.result = "";
        ui.translate.status = "error";
      }
      updateTranslatePanel();
    });
  }

  function scheduleTranslation() {
    clearTimeout(ui.translate.timer);
    ui.translate.timer = setTimeout(runTranslation, 650);
  }

  function translateHTML() {
    var t = ui.translate;
    return (
      '<section class="card hero-card" style="background:linear-gradient(135deg,#6c5ce7,#38c6f4)">' +
      '<div class="hero-head-row"><span class="mascot">🅰️</span><div>' +
      '<p class="hero-kicker">WORD TRANSLATOR</p><h1 class="hero-title">中英互译</h1>' +
      '<p class="hero-sub">输入中文或英文，自动翻译并可以直接加入词库。</p>' +
      "</div></div></section>" +
      '<section class="card">' +
      '<div class="seg" style="margin-bottom:14px">' +
      '<button class="seg-btn' +
      (t.mode === "auto" ? " active" : "") +
      '" data-act="translate-mode" data-value="auto">自动识别</button>' +
      '<button class="seg-btn' +
      (t.mode === "zh-en" ? " active" : "") +
      '" data-act="translate-mode" data-value="zh-en">中 → 英</button>' +
      '<button class="seg-btn' +
      (t.mode === "en-zh" ? " active" : "") +
      '" data-act="translate-mode" data-value="en-zh">英 → 中</button>' +
      "</div>" +
      '<label class="field"><span>输入内容</span><textarea data-translate-input rows="4" maxlength="220" placeholder="例如：苹果 / apple">' +
      esc(t.input) +
      "</textarea></label>" +
      '<div class="actions">' +
      '<button class="btn primary" data-act="translate-run">翻译</button>' +
      '<button class="btn ghost" data-act="translate-clear">清空</button>' +
      "</div>" +
      '<div data-translate-panel>' +
      translatePanelHTML(t) +
      "</div>" +
      "</section>"
    );
  }

  /* ==================== 视图渲染 ==================== */

  function barTitle() {
    if (state.view === "review") return "今日复习";
    if (state.view === "translate") return "翻译";
    if (state.view === "records") return "成长记录";
    if (state.view === "profile") return "我的";
    if (state.view === "game") {
      var g = ui.game;
      return g ? MODE_LABELS[g.mode] || "学习中" : "学习";
    }
    return "单词星球";
  }

  function topbarHTML() {
    var left = '<span class="bar-side"></span>';
    if (state.view === "game") {
      left = '<span class="bar-side"><button class="icon-btn" data-act="quit-game" aria-label="退出游戏">‹</button></span>';
    }
    return (
      '<header class="topbar">' +
      left +
      '<span class="bar-title">' +
      esc(barTitle()) +
      "</span>" +
      '<span class="bar-side"></span>' +
      "</header>"
    );
  }

  var TABS = [
    {
      key: "home",
      label: "首页",
      outline: '<path d="M4.2 10.8 12 4.2l7.8 6.6"/><path d="M6.2 9.2V19a1.5 1.5 0 0 0 1.5 1.5h8.6A1.5 1.5 0 0 0 17.8 19V9.2"/><path d="M10 20.5v-6h4v6"/>',
      solid: '<path d="M11.2 3.8 3.7 10.1a.9.9 0 0 0-.3.7v8.6a1.6 1.6 0 0 0 1.6 1.6h4.2v-6.1h5.6V21h4.2a1.6 1.6 0 0 0 1.6-1.6v-8.6a.9.9 0 0 0-.3-.7L12.8 3.8a1.5 1.5 0 0 0-1.6 0Z"/>'
    },
    {
      key: "review",
      label: "复习",
      outline: '<path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z"/><path d="M12 8v4l3 2"/>',
      solid:
        "<mask id='lg-ic-review'><rect width='24' height='24' fill='#fff'/>" +
        "<path d='M12 7.2v5l3.4 2' fill='none' stroke='#000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/></mask>" +
        "<circle cx='12' cy='12' r='9.2' fill='currentColor' mask='url(#lg-ic-review)'/>"
    },
    {
      key: "translate",
      label: "翻译",
      outline: '<path d="M5.2 19 11 5.4h2L18.8 19"/><path d="M7.8 13.8h8.4"/>',
      solid: '<path d="M10.8 4.8h2.4l6 14.4h-2.7l-1.2-3H8.7l-1.2 3H4.8l6-14.4Zm1.2 3.4-2 5h4l-2-5Z"/>'
    },
    {
      key: "records",
      label: "记录",
      outline: '<rect x="4" y="5.2" width="16" height="14.5" rx="3.2"/><path d="M4 9.7h16M8.2 3.8v3M15.8 3.8v3"/><path d="M8 13.2h1.6M12 13.2h1.6M16 13.2h1.6M8 16.5h1.6M12 16.5h1.6"/>',
      solid:
        "<mask id='lg-ic-records'><rect width='24' height='24' fill='#fff'/>" +
        "<path d='M4.2 9.7h15.6' stroke='#000' stroke-width='1.6'/>" +
        "<rect x='8' y='13' width='2.1' height='2.1' rx='.6' fill='#000'/>" +
        "<rect x='11' y='13' width='2.1' height='2.1' rx='.6' fill='#000'/>" +
        "<rect x='14' y='13' width='2.1' height='2.1' rx='.6' fill='#000'/>" +
        "<rect x='8' y='16.2' width='2.1' height='2.1' rx='.6' fill='#000'/></mask>" +
        "<rect x='4' y='5.2' width='16' height='14.5' rx='3.2' fill='currentColor' mask='url(#lg-ic-records)'/>" +
        "<rect x='8.2' y='3.8' width='1.7' height='3' rx='.85' fill='currentColor'/>" +
        "<rect x='14.1' y='3.8' width='1.7' height='3' rx='.85' fill='currentColor'/>"
    },
    {
      key: "profile",
      label: "我的",
      outline: '<circle cx="12" cy="8" r="3.6"/><path d="M5 19.2c.8-3.1 3.1-4.7 7-4.7s6.2 1.6 7 4.7"/>',
      solid: '<circle cx="12" cy="8" r="3.6" fill="currentColor"/><path d="M5 19.2c.8-3.1 3.1-4.7 7-4.7s6.2 1.6 7 4.7Z" fill="currentColor"/>'
    }
  ];

  function tabbarHTML() {
    var due = dueReviewWords().length;
    var items = TABS.map(function (tab, index) {
      var active = state.view === tab.key;
      var badge = tab.key === "review" && due ? '<span class="tab-badge"></span>' : "";
      var button =
        '<button class="tab-btn' +
        (active ? " active" : "") +
        '" data-act="nav" data-view="' +
        tab.key +
        '" aria-label="' +
        esc(tab.label) +
        '">' +
        '<span class="tab-glyph">' +
        '<svg class="tab-icon icon-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        tab.outline +
        "</svg>" +
        '<svg class="tab-icon icon-solid" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
        tab.solid +
        "</svg>" +
        badge +
        "</span></button>";
      return button;
    }).join("");
    return (
      '<nav class="tabbar glass">' +
      '<span class="tab-indicator" aria-hidden="true"></span>' +
      items +
      "</nav>"
    );
  }

  function setupTabbar() {
    var bar = $(".tabbar");
    if (!bar) return;
    var indicator = $(".tab-indicator", bar);
    var buttons = $$(".tab-btn", bar);
    if (!indicator || buttons.length < 2) return;

    var activeIndex = 0;
    var i;
    for (i = 0; i < buttons.length; i++) {
      if (buttons[i].classList.contains("active")) activeIndex = i;
    }

    var PILL_EXTRA = 10;
    var MIN_GAP = 4;

    function limit(value, min, max) {
      return value < min ? min : value > max ? max : value;
    }

    function originX() {
      return bar.getBoundingClientRect().left + bar.clientLeft;
    }

    function spanOf(index) {
      var rect = buttons[index].getBoundingClientRect();
      return { offset: rect.left - originX(), width: rect.width };
    }

    function maxOffset() {
      var pillWidth = spanOf(0).width + PILL_EXTRA * 2;
      return Math.max(MIN_GAP, bar.clientWidth - MIN_GAP - pillWidth);
    }

    function geometry(index, stretch) {
      var span = spanOf(index);
      var offset = span.offset - PILL_EXTRA;
      var width = span.width + PILL_EXTRA * 2;
      var extra = stretch ? width * 0.16 : 0;
      var left = offset - extra / 2;
      var right = offset + width + extra / 2;
      var shift = 0;
      if (left < MIN_GAP) shift = MIN_GAP - left;
      else if (right > bar.clientWidth - MIN_GAP) shift = bar.clientWidth - MIN_GAP - right;
      return { index: index, offset: offset + shift, width: width };
    }

    function paint(geom) {
      indicator.style.width = geom.width + "px";
      indicator.style.transform = "translateX(" + geom.offset + "px)";
    }

    function place(index) {
      indicator.style.transition = "none";
      paint(geometry(index, false));
      void indicator.offsetWidth;
      indicator.style.transition = "";
    }

    function centerOf(index) {
      var span = spanOf(index);
      return span.offset + span.width / 2;
    }

    function nearestIndex(offset, width) {
      var center = offset + width / 2;
      var best = 0;
      var bestDistance = Infinity;
      for (var k = 0; k < buttons.length; k++) {
        var distance = Math.abs(centerOf(k) - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = k;
        }
      }
      return best;
    }

    function indexAtX(x) {
      for (var k = 0; k < buttons.length; k++) {
        var span = spanOf(k);
        if (x >= span.offset && x <= span.offset + span.width) return k;
      }
      var width = spanOf(0).width;
      return nearestIndex(limit(x - width / 2, 0, maxOffset()), width);
    }

    var previous = ui.tabGeom;
    var shouldAnimate = previous && previous.index !== activeIndex;
    if (shouldAnimate) {
      indicator.style.transition = "none";
      paint(previous);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          indicator.style.transition = "";
          indicator.style.transitionDuration = "0.34s";
          paint(geometry(activeIndex, true));
          clearTimeout(ui.tabTimer);
          ui.tabTimer = setTimeout(function () {
            indicator.style.transitionDuration = "";
            paint(geometry(activeIndex, false));
          }, 170);
        });
      });
    } else {
      place(activeIndex);
    }
    ui.tabGeom = geometry(activeIndex, false);

    bar.__sync = function () {
      place(activeIndex);
      ui.tabGeom = geometry(activeIndex, false);
    };

    var startX = 0;
    var startOffset = 0;
    var dragging = false;
    var moved = false;

    bar.addEventListener("pointerdown", function (event) {
      if (event.button) return;
      startX = event.clientX;
      startOffset = indicator.getBoundingClientRect().left - bar.getBoundingClientRect().left - bar.clientLeft;
      dragging = true;
      moved = false;
      indicator.style.transition = "none";
      if (bar.setPointerCapture) bar.setPointerCapture(event.pointerId);
    });

    bar.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      var dx = event.clientX - startX;
      if (!moved && Math.abs(dx) < 6) return;
      moved = true;
      bar.classList.add("dragging");
      var geom = {
        offset: limit(startOffset + dx, 0, maxOffset()),
        width: spanOf(0).width + PILL_EXTRA * 2
      };
      paint(geom);
      var near = nearestIndex(geom.offset, geom.width);
      for (var k = 0; k < buttons.length; k++) {
        buttons[k].classList.toggle("near", k === near);
      }
    });

    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      indicator.style.transition = "";
      bar.classList.remove("dragging");
      for (var k = 0; k < buttons.length; k++) buttons[k].classList.remove("near");
      var width = spanOf(0).width + PILL_EXTRA * 2;

      if (!moved) {
        var tapIndex = indexAtX(event.clientX - bar.getBoundingClientRect().left - bar.clientLeft);
        place(activeIndex);
        if (tapIndex !== activeIndex) goTo(TABS[tapIndex].key);
        return;
      }

      var offset = limit(startOffset + (event.clientX - startX), 0, maxOffset());
      var index = nearestIndex(offset, width);
      ui.suppressTabClick = Date.now() + 500;
      ui.tabGeom = { index: index, offset: offset, width: width };
      paint(ui.tabGeom);
      if (index === activeIndex) render();
      else goTo(TABS[index].key);
    }

    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);
  }

  function goTo(view) {
    if (state.view === "game") ui.game = null;
    state.view = view;
    save();
    render(true);
  }

  function statPill(label, value) {
    return (
      '<div class="stat-pill"><span class="k">' +
      esc(label) +
      '</span><span class="v">' +
      esc(value) +
      "</span></div>"
    );
  }

  function modeCard(mode, icon, name, desc, glow) {
    var disabled = state.words.length === 0;
    return (
      '<button class="mode-card' +
      (disabled ? " disabled" : "") +
      '" data-act="start-mode" data-mode="' +
      mode +
      '" style="--mode-glow:' +
      glow +
      '">' +
      '<span class="mode-icon">' +
      icon +
      "</span>" +
      '<span class="mode-name">' +
      name +
      "</span>" +
      '<span class="mode-desc">' +
      esc(desc) +
      "</span>" +
      '<span class="mode-go">开始学习 ›</span>' +
      "</button>"
    );
  }

  function homeHTML() {
    var now = Date.now();
    var today = dayKey(now);
    var checked = state.checkins.indexOf(today) !== -1;
    var newCount = Math.min(dueNewWords().length, state.settings.dailyNew);
    var reviewCount = dueReviewWords().length;
    var mastered = masteredWords().length;
    var streak = streakDays();

    var hero =
      '<section class="card hero-card">' +
      '<div class="hero-head-row">' +
      '<span class="mascot">🦊</span>' +
      '<div>' +
      '<p class="hero-kicker">WORD PLANET · ' +
      pad2(new Date(now).getMonth() + 1) +
      "/" +
      pad2(new Date(now).getDate()) +
      "</p>" +
      '<h1 class="hero-title">今天也要开心记单词</h1>' +
      '<p class="hero-sub">拍下单词表，玩着玩着就记住了。</p>' +
      "</div></div>" +
      '<div class="hero-actions">' +
      '<button class="btn primary" data-act="album">🖼 相册识词</button>' +
      '<button class="btn" data-act="manual">✏️ 添加单词</button>' +
      '<button class="btn" data-act="checkin">' +
      (checked ? "✅ 今天已签到" : "🌟 签到") +
      "</button>" +
      "</div></section>";

    var stats =
      '<div class="stat-strip">' +
      statPill("待学新词", newCount) +
      statPill("待复习", reviewCount) +
      statPill("已掌握", mastered) +
      statPill("连续签到", streak + " 天") +
      "</div>";

    var modes =
      '<div class="section-head"><h2 class="section-title">今天怎么学？</h2><span class="section-hint">选一种喜欢的方式</span></div>' +
      '<div class="mode-grid">' +
      modeCard("balloon", "🎈", "气球配对", "把英文和中文连起来，像消消乐一样。", "rgba(255,140,184,.16)") +
      modeCard("spell", "🧩", "拼写闯关", "补全、拼字母、默写，一层层闯关。", "rgba(108,92,231,.16)") +
      modeCard("dictation", "🎧", "听写默写", "听声音写单词，不会时再看中文。", "rgba(62,198,181,.16)") +
      modeCard("review", "⏳", "智能复习", "按遗忘曲线复习，记得更牢。", "rgba(255,201,77,.18)") +
      "</div>";

    var review =
      '<section class="card">' +
      '<div class="section-head"><h3>📅 今日复习</h3><span class="section-hint">' +
      (reviewCount ? reviewCount + " 个到期" : "已完成") +
      "</span></div>" +
      '<p class="muted small">根据遗忘曲线安排：新学 1 天后复习，之后是 2、4、7、15、30、60 天。</p>' +
      '<div class="actions">' +
      '<button class="btn ' +
      (reviewCount ? "primary" : "ghost") +
      '" data-act="start-review">' +
      (reviewCount ? "开始今日复习" : "没有到期单词，去学新的吧") +
      "</button>" +
      "</div></section>";

    if (!state.words.length) {
      return (
        hero +
        '<section class="card empty-cartoon"><span class="big">🪄</span><h3>词库还是空的</h3><p class="muted">拍一张单词表，或者先添加几个单词，就能开始玩游戏啦。</p>' +
        '<div class="actions"><button class="btn primary" data-act="album">从相册识词</button><button class="btn" data-act="manual">手动添加单词</button></div></section>'
      );
    }
    return hero + stats + modes + review;
  }

  function reviewHTML() {
    var due = dueReviewWords();
    var mastered = masteredWords().length;
    var total = state.words.length;
    var preview = due.slice(0, 6);
    return (
      '<section class="card hero-card" style="background:linear-gradient(135deg,#3ec6b5,#6c5ce7)">' +
      '<div class="hero-head-row"><span class="mascot">⏳</span><div>' +
      '<p class="hero-kicker">FORGETTING CURVE</p><h1 class="hero-title">' +
      (due.length ? "今天有 " + due.length + " 个单词等你复习" : "今天复习完成啦") +
      "</h1>" +
      '<p class="hero-sub">记住不是一次就够，大脑喜欢“快要忘记时再见一面”。</p>' +
      "</div></div></section>" +
      '<div class="stat-strip">' +
      statPill("今日到期", due.length) +
      statPill("已掌握", mastered) +
      statPill("词库总数", total) +
      statPill("连续签到", streakDays() + " 天") +
      "</div>" +
      '<section class="card">' +
      '<div class="section-head"><h3>复习队列</h3><span class="section-hint">按最该复习的顺序排</span></div>' +
      (preview.length
        ? '<div class="list">' +
          preview
            .map(function (word) {
              return (
                '<div class="word-row"><span class="word-en">' +
                esc(word.en) +
                '</span><span class="word-zh">' +
                esc(word.zh) +
                '</span><span class="word-stage">' +
                stageLabel(word) +
                "</span></div>"
              );
            })
            .join("") +
          "</div>" +
          (due.length > 6 ? '<p class="muted small">还有 ' + (due.length - 6) + " 个没有显示。</p>" : "")
        : '<div class="empty-cartoon"><span class="big">🎉</span><p class="muted">没有到期复习。可以去首页学新词，或做一轮已掌握单词的巩固练习。</p></div>') +
      '<div class="actions">' +
      '<button class="btn primary" data-act="start-review"' +
      (due.length ? "" : " disabled") +
      ">开始今日复习</button>" +
      '<button class="btn ghost" data-act="practice">巩固已掌握单词</button>' +
      "</div></section>" +
      '<section class="card"><h3>怎么安排复习？</h3><p class="muted small">第一次学完，明天复习；答对就拉长间隔，答错就回到短间隔。这样比每天从头背更省力。</p></section>'
    );
  }

  function cursorMonth() {
    return ui.monthCursor || currentMonth(Date.now());
  }

  function cursorYear() {
    return ui.yearCursor == null ? new Date().getFullYear() : ui.yearCursor;
  }

  var WEEKDAY_ROW = ["一", "二", "三", "四", "五", "六", "日"]
    .map(function (w) {
      return "<span>" + w + "</span>";
    })
    .join("");

  function monthCalendarHTML(year, month, now) {
    var cells = monthCells(year, month, now);
    var dayCells = cells
      .map(function (cell) {
        if (cell.blank) return '<span class="day blank"></span>';
        var cls = ["day"];
        if (cell.done) cls.push("done");
        if (cell.today) cls.push("today");
        if (cell.future) cls.push("future");
        return (
          '<span class="' +
          cls.join(" ") +
          '"><span class="day-num">' +
          cell.day +
          '</span><span class="day-mark"></span></span>'
        );
      });
    var weeks = "";
    for (var i = 0; i < dayCells.length; i += 7) {
      weeks += '<div class="cal-week">' + dayCells.slice(i, i + 7).join("") + "</div>";
    }
    var names = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
    return (
      '<div class="cal-head">' +
      '<button class="icon-btn" data-act="month-prev" aria-label="上个月">‹</button>' +
      '<span class="cal-year">' +
      year +
      " 年</span>" +
      '<button class="icon-btn" data-act="month-next" aria-label="下个月">›</button>' +
      '<button class="link-btn" data-act="month-now">回到本月</button>' +
      "</div>" +
      '<h2 class="cal-title">' +
      names[month] +
      "</h2>" +
      '<div class="cal-weekdays">' +
      WEEKDAY_ROW +
      "</div>" +
      '<div class="cal-weeks">' +
      weeks +
      "</div>"
    );
  }

  function yearHTML() {
    var now = Date.now();
    var year = cursorYear();
    var months = yearMonths(year, now);
    var total = state.checkins.filter(function (key) {
      return key.indexOf(String(year) + "-") === 0;
    }).length;
    return (
      '<section class="year-view">' +
      '<div class="year-head">' +
      '<button class="icon-btn" data-act="year-prev" aria-label="上一年">‹</button>' +
      '<h2 class="year-title">' +
      year +
      " 年</h2>" +
      '<button class="icon-btn" data-act="year-next" aria-label="下一年">›</button>' +
      "</div>" +
      '<div class="mini-grid">' +
      months
        .map(function (item) {
          var count = item.cells.filter(function (c) {
            return c.done;
          }).length;
          var cells = item.cells
            .map(function (cell) {
              if (cell.blank) return '<span class="mini-day blank"></span>';
              var cls = ["mini-day"];
              if (cell.future) cls.push("future");
              if (cell.done) cls.push("done");
              return '<span class="' + cls.join(" ") + '">' + cell.day + "</span>";
            })
            .join("");
          return (
            '<button class="mini" data-act="goto-month" data-month="' +
            item.month +
            '"><span class="mini-label">' +
            item.label +
            " · " +
            count +
            ' 天</span><span class="mini-cal">' +
            cells +
            "</span></button>"
          );
        })
        .join("") +
      "</div>" +
      '<p class="muted small year-sum">全年签到 ' +
      total +
      " 天 · 累计学习 " +
      state.sessions.length +
      " 次 · 连续签到 " +
      streakDays() +
      ' 天</p>' +
      '<div class="actions"><button class="link-btn" data-act="year-now">回到今年</button></div>' +
      "</section>"
    );
  }

  function recordsHTML() {
    var now = Date.now();
    var cursor = cursorMonth();
    var monthTotal = state.checkins.filter(function (key) {
      return key.indexOf(cursor.year + "-" + pad2(cursor.month + 1)) === 0;
    }).length;
    var sessions = sessionsByMonth(cursor.year, cursor.month);
    var modeSeg =
      '<div class="seg" style="margin-bottom:14px">' +
      '<button class="seg-btn' +
      (ui.recordsMode === "month" ? " active" : "") +
      '" data-act="records-mode" data-value="month">月记录</button>' +
      '<button class="seg-btn' +
      (ui.recordsMode === "year" ? " active" : "") +
      '" data-act="records-mode" data-value="year">年记录</button>' +
      "</div>";
    return (
      modeSeg +
      '<div class="stat-strip" style="margin-bottom:14px">' +
      statPill("本月签到", monthTotal) +
      statPill("累计签到", state.checkins.length) +
      statPill("学习次数", state.sessions.length) +
      statPill("连续", streakDays() + " 天") +
      "</div>" +
      (ui.recordsMode === "year"
        ? yearHTML()
        : '<section class="card">' +
          monthCalendarHTML(cursor.year, cursor.month, now) +
          '<p class="muted small">本月签到 ' +
          monthTotal +
          " 天 · 学习 " +
          sessions.length +
          " 次 · 学对 " +
          sessions.reduce(function (a, r) {
            return a + (r.correct || 0);
          }, 0) +
          " 词</p>" +
          "</section>")
    );
  }

  function profileHTML() {
    var wordCount = state.words.length;
    var mastered = masteredWords().length;
    var themes = { light: "浅色", dark: "深色", system: "跟随系统" };
    var themeSeg = ["light", "dark", "system"]
      .map(function (key) {
        return (
          '<button class="seg-btn' +
          (state.theme === key ? " active" : "") +
          '" data-act="theme" data-value="' +
          key +
          '">' +
          themes[key] +
          "</button>"
        );
      })
      .join("");
    return (
      '<section class="card hero-card" style="background:linear-gradient(135deg,#ff9cc8,#ffc94d)">' +
      '<div class="hero-head-row"><span class="mascot">🎒</span><div>' +
      '<p class="hero-kicker">MY WORD PLANET</p><h1 class="hero-title">我的单词星球</h1>' +
      '<p class="hero-sub">' +
      wordCount +
      " 个单词 · " +
      mastered +
      " 个已掌握</p>" +
      "</div></div></section>" +
      '<div class="stat-strip">' +
      statPill("词库", wordCount) +
      statPill("已掌握", mastered) +
      statPill("签到", state.checkins.length) +
      statPill("学习", state.sessions.length) +
      "</div>" +
      '<section class="card"><h3>学习设置</h3>' +
      '<div class="form">' +
      '<label class="field"><span>每天学习新词数量</span><input type="number" min="3" max="30" data-setting="dailyNew" value="' +
      state.settings.dailyNew +
      '"></label>' +
      '<label class="field"><span>复习发音</span><select data-setting="sound">' +
      '<option value="1"' +
      (state.settings.sound ? " selected" : "") +
      ">开启</option>" +
      '<option value="0"' +
      (!state.settings.sound ? " selected" : "") +
      ">关闭</option></select></label>" +
      "</div></section>" +
      '<section class="card"><h3>词库</h3>' +
      '<div class="list">' +
      '<button class="list-row" data-act="album"><span class="row-tile">🖼</span><span class="row-name">从相册导入识词</span><span class="row-chev">›</span></button>' +
      '<button class="list-row" data-act="manual"><span class="row-tile">✏️</span><span class="row-name">手动添加单词</span><span class="row-chev">›</span></button>' +
      '<button class="list-row" data-act="word-manager"><span class="row-tile">📚</span><span class="row-name">管理我的词库</span><span class="row-chev">›</span></button>' +
      '<button class="list-row" data-act="seed"><span class="row-tile">✨</span><span class="row-name">载入示例单词</span><span class="row-chev">›</span></button>' +
      "</div></section>" +
      '<section class="card"><h3>外观</h3><div class="seg">' +
      themeSeg +
      "</div></section>" +
      '<section class="card"><h3>数据</h3>' +
      '<div class="list">' +
      '<button class="list-row" data-act="export"><span class="row-tile">💾</span><span class="row-name">导出备份</span><span class="row-chev">›</span></button>' +
      '<button class="list-row" data-act="import"><span class="row-tile">📥</span><span class="row-name">导入备份</span><span class="row-chev">›</span></button>' +
      '<button class="list-row" data-act="clear"><span class="row-tile">🗑️</span><span class="row-name">清空所有数据</span><span class="row-chev">›</span></button>' +
      "</div>" +
      '<p class="muted small">数据只存在这台设备的浏览器里。清空浏览器数据会删除记录，建议定期导出备份。</p>' +
      "</section>"
    );
  }

  function viewHTML() {
    if (state.view === "review") return reviewHTML();
    if (state.view === "translate") return translateHTML();
    if (state.view === "records") return recordsHTML();
    if (state.view === "profile") return profileHTML();
    return homeHTML();
  }

  function gameProgress() {
    var g = ui.game;
    if (!g) return 0;
    var done;
    if (g.mode === "balloon") {
      done = g.index + g.matched;
      if (g.selectedEn !== null || g.selectedZh !== null) done += 0.35;
    } else if (g.mode === "spell") {
      done = g.index + Math.max(0, Number(g.step) - 1) / 3;
    } else if (g.mode === "dictation") {
      done = g.index + (g.step === "write" ? 0.5 : 0);
    } else if (g.mode === "review") {
      done = g.index + (g.revealed ? 0.45 : 0);
    } else {
      done = g.index;
    }
    return Math.max(0, Math.min(100, (done / Math.max(1, g.words.length)) * 100));
  }

  function updateTypingProgress() {
    var g = ui.game;
    if (!g) return;
    var input = $("#game-input");
    var word = g.words[g.index];
    if (!input || !word) return;
    var typed = cleanEnglish(input.value).length;
    var partial = Math.min(0.9, (typed / Math.max(1, word.en.length)) * 0.9);
    var done;
    if (g.mode === "spell") done = g.index + partial;
    else if (g.mode === "dictation") done = g.index + (g.step === "write" ? 0.45 : 0) + partial * 0.45;
    else return;
    var bar = $(".game-progress > span");
    if (bar) bar.style.width = Math.max(0, Math.min(100, (done / Math.max(1, g.words.length)) * 100)).toFixed(2) + "%";
  }

  function gameHTML() {
    var g = ui.game;
    if (!g) return '<p class="muted">游戏已结束。</p>';
    var top =
      '<div class="game-top">' +
      '<div class="game-score">' +
      g.score +
      " 分</div>" +
      (g.mode === "spell"
        ? ""
        : '<div class="game-progress"><span style="width:' +
          gameProgress().toFixed(2) +
          '%"></span></div>') +
      "</div>";
    if (g.finished) return top + gameResultHTML();
    if (g.mode === "balloon") return top + balloonHTML();
    if (g.mode === "spell") return top + spellHTML();
    if (g.mode === "dictation") return top + dictationHTML();
    if (g.mode === "review") return top + reviewGameHTML();
    return top;
  }

  function balloonHTML() {
    var g = ui.game;
    var cards = g.cards
      .map(function (card, index) {
        var cls = ["balloon-card", card.type];
        if (card.matched) cls.push("matched");
        if (card.exploding) cls.push("exploding");
        if (g.selectedEn === index || g.selectedZh === index) cls.push("selected");
        if (g.feedback === "bad" && (g.selectedEn === index || g.selectedZh === index)) cls.push("wrong");
        return (
          '<button type="button" class="' +
          cls.join(" ") +
          '" data-game="balloon" data-index="' +
          index +
          '">' +
          '<span class="balloon-body">' +
          esc(card.text) +
          '<span class="balloon-string" aria-hidden="true"></span>' +
          "</span>" +
          '<span class="balloon-blast" aria-hidden="true"></span>' +
          "</button>"
        );
      })
      .join("");
    var feedback =
      g.feedback === "good"
        ? '<p class="game-feedback good">配对成功！🎉</p>'
        : g.feedback === "bad"
        ? '<p class="game-feedback bad">不对哦，再试一次</p>'
        : "";
    return (
      '<section class="game-panel">' +
      '<p class="game-label">第 ' +
      (Math.floor(g.index / 3) + 1) +
      " 关 · 把英文和中文连起来</p>" +
      '<div class="match-grid">' +
      cards +
      "</div>" +
      feedback +
      "</section>"
    );
  }

  function spellHTML() {
    var g = ui.game;
    var word = g.words[g.index];
    return (
      '<section class="game-panel">' +
      '<p class="game-label">看中文拼单词</p>' +
      '<div class="zh-big">' +
      esc(word.zh) +
      "</div>" +
      '<div class="game-actions"><button class="speak-btn" data-game="speak">🔊</button></div>' +
      '<div style="margin-top:14px"><input id="game-input" class="game-input" data-game-input data-submit="spell" placeholder="输入英文" autocapitalize="off" autocomplete="off" spellcheck="false"></div>' +
      (g.revealed ? '<p class="game-feedback good">答案是 ' + esc(word.en.toUpperCase()) + "</p>" : "") +
      (g.feedback === "bad" ? '<p class="game-feedback bad">还差一点，再试一次</p>' : "") +
      '<div class="game-actions"><button class="btn primary" data-game="submit-spell">检查</button></div>' +
      "</section>"
    );
  }

  function dictationHTML() {
    var g = ui.game;
    var word = g.words[g.index];
    var listen = g.step === "listen";
    return (
      '<section class="game-panel">' +
      '<p class="game-label">' +
      (listen ? "听音写单词" : "看中文再写一次") +
      "</p>" +
      (listen ? "" : '<div class="zh-big">' + esc(word.zh) + "</div>") +
      '<div class="game-actions"><button class="speak-btn" data-game="speak">🔊</button></div>' +
      '<div style="margin-top:14px"><input id="game-input" class="game-input" data-game-input data-submit="dict" placeholder="输入听到的英文" autocapitalize="off" autocomplete="off" spellcheck="false"></div>' +
      (g.revealed ? '<p class="game-feedback good">答案是 ' + esc(word.en.toUpperCase()) + "</p>" : "") +
      (g.feedback === "bad" ? '<p class="game-feedback bad">再听一次，慢慢拼</p>' : "") +
      '<div class="game-actions"><button class="btn primary" data-game="submit-dict">检查</button></div>' +
      "</section>"
    );
  }

  function reviewGameHTML() {
    var g = ui.game;
    var word = g.words[g.index];
    return (
      '<section class="game-panel">' +
      '<p class="game-label">第 ' +
      (g.index + 1) +
      " / " +
      g.words.length +
      " 个</p>" +
      '<div class="review-flip">' +
      '<button class="speak-btn" data-game="speak">🔊</button>' +
      '<div class="big-word">' +
      esc(word.en) +
      "</div>" +
      (g.revealed
        ? '<div class="zh-big">' +
          esc(word.zh) +
          "</div>" +
          (word.phonetic ? '<p class="muted small">' + esc(word.phonetic) + "</p>" : "") +
          '<p class="muted small">你记得怎么样？</p>' +
          '<div class="grade-row">' +
          '<button class="grade-btn grade-again" data-game="grade" data-grade="again">忘了</button>' +
          '<button class="grade-btn grade-hard" data-game="grade" data-grade="hard">想一想</button>' +
          '<button class="grade-btn grade-good" data-game="grade" data-grade="good">认识</button>' +
          "</div>"
        : '<div class="game-actions"><button class="btn primary" data-game="reveal">看看中文</button></div>') +
      "</div></section>"
    );
  }

  function gameResultHTML() {
    var g = ui.game;
    var ratio = g.total ? g.correct / g.total : 0;
    var stars = ratio >= 0.92 ? "⭐⭐⭐" : ratio >= 0.65 ? "⭐⭐" : "⭐";
    var emoji = ratio >= 0.92 ? "🏆" : ratio >= 0.65 ? "🎉" : "💪";
    return (
      '<section class="game-panel">' +
      '<div class="result-emoji">' +
      emoji +
      "</div>" +
      '<div class="stars">' +
      stars +
      "</div>" +
      "<h2>" +
      (ratio >= 0.92 ? "太棒了！" : ratio >= 0.65 ? "完成得不错！" : "继续加油！") +
      "</h2>" +
      '<p class="muted">本组 ' +
      g.total +
      " 词 · 答对 " +
      g.correct +
      " · 得分 " +
      g.score +
      "</p>" +
      '<div class="game-actions">' +
      '<button class="btn primary" data-game="again">再学一组</button>' +
      '<button class="btn ghost" data-game="home">回到首页</button>' +
      "</div></section>"
    );
  }

  function render(resetScroll) {
    var theme = resolvedTheme();
    document.documentElement.setAttribute("data-theme", theme);
    var themeColor = document.getElementById("themeColor");
    if (themeColor) themeColor.setAttribute("content", theme === "light" ? "#f7f3ff" : "#141126");
    var statusBar = document.getElementById("statusBarStyle");
    if (statusBar) statusBar.setAttribute("content", theme === "light" ? "default" : "black-translucent");

    var y = window.scrollY;
    var html =
      topbarHTML() +
      (state.view === "game"
        ? '<main class="game-main">' + gameHTML() + "</main>"
        : '<main class="main">' + viewHTML() + "</main>" + tabbarHTML());
    $("#app").innerHTML = html;

    if (state.view !== "game") setupTabbar();

    var viewKey = state.view + ":" + (ui.game ? ui.game.mode + ":" + ui.game.index + ":" + ui.game.step : "");
    var changed = viewKey !== ui.lastViewKey;
    ui.lastViewKey = viewKey;
    if ((changed || ui.forceAnim) && !reduceMotion() && state.view !== "game") {
      var main = $(".main");
      if (main) main.classList.add("anim-in");
    }
    ui.forceAnim = false;

    if (window.LiquidGlass && window.LiquidGlass.refresh) window.LiquidGlass.refresh();
    window.scrollTo(0, resetScroll ? 0 : y);
  }

  /* ==================== 数据导入导出 ==================== */

  function exportData() {
    var payload = {
      app: "wordplanet",
      version: 1,
      exportedAt: new Date().toISOString(),
      theme: state.theme,
      settings: state.settings,
      words: state.words,
      checkins: state.checkins,
      sessions: state.sessions
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "wordplanet-backup-" + dayKey(Date.now()) + ".json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    toast("备份已导出");
  }

  function importData() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var data;
        try {
          data = JSON.parse(String(reader.result));
        } catch (err) {
          toast("这个文件不是有效的备份");
          return;
        }
        if (!data || !Array.isArray(data.words)) {
          toast("备份格式不对，缺少 words 字段");
          return;
        }
        if (!window.confirm("导入会覆盖当前所有记录，确定继续吗？")) return;
        state.words = data.words.map(normalizeWord).filter(function (w) {
          return !!w;
        });
        state.checkins = Array.isArray(data.checkins) ? data.checkins.filter(function (k) {
          return typeof k === "string";
        }) : [];
        state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        state.settings = Object.assign({}, emptyState().settings, data.settings || {});
        state.seeded = true;
        state.view = "home";
        save();
        render(true);
        toast("已恢复 " + state.words.length + " 个单词");
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function clearAll() {
    if (!window.confirm("确定要清空所有单词、签到和学习记录吗？建议先导出备份。")) return;
    if (!window.confirm("再确认一次：清空后无法撤销。")) return;
    state.words = [];
    state.checkins = [];
    state.sessions = [];
    state.seeded = true;
    state.view = "home";
    save();
    render(true);
    toast("已清空");
  }

  function seedDemo() {
    if (state.words.length && !window.confirm("载入示例不会删除现有单词，确定继续吗？")) return;
    var count = addWords(DEMO_WORDS.map(function (item) {
      return { en: item.en, zh: item.zh, source: "demo" };
    }));
    state.seeded = true;
    save();
    render();
    toast(count ? "已载入 " + count + " 个示例单词" : "示例单词已经在词库里了");
  }

  /* ==================== 事件处理 ==================== */

  function handleAct(el) {
    var act = el.getAttribute("data-act");
    if (act === "nav") {
      if (ui.suppressTabClick && Date.now() < ui.suppressTabClick && el.classList.contains("tab-btn")) return;
      if (el.classList.contains("tab-btn")) tapFeedback();
      goTo(el.getAttribute("data-view"));
      return;
    }
    if (act === "manual") {
      openManualAdd();
      return;
    }
    if (act === "album") {
      openAlbumImport();
      return;
    }
    if (act === "word-manager") {
      openWordManager();
      return;
    }
    if (act === "checkin") {
      var key = dayKey(Date.now());
      if (state.checkins.indexOf(key) !== -1) {
        toast("今天已经签到啦 ✅");
      } else {
        addCheckin();
        save();
        tapFeedback(true);
        render();
        toast("签到成功，今天也来星球打卡了 🌟");
      }
      return;
    }
    if (act === "start-mode") {
      var mode = el.getAttribute("data-mode");
      if (mode === "balloon" || mode === "spell") openWordPicker(mode);
      else startMode(mode);
      return;
    }
    if (act === "start-review") {
      startMode("review");
      return;
    }
    if (act === "translate-mode") {
      ui.translate.mode = el.getAttribute("data-value") || "auto";
      ui.translate.result = "";
      ui.translate.status = "";
      render();
      scheduleTranslation();
      return;
    }
    if (act === "translate-run") {
      runTranslation();
      return;
    }
    if (act === "translate-clear") {
      ui.translate.input = "";
      ui.translate.result = "";
      ui.translate.status = "";
      ui.translate.loading = false;
      render();
      return;
    }
    if (act === "translate-speak") {
      var spoken = ui.translate.to === "en" ? ui.translate.result : ui.translate.input;
      if (spoken) speak(spoken);
      return;
    }
    if (act === "translate-add") {
      var a = ui.translate.input.trim();
      var b = ui.translate.result.trim();
      if (!a || !b) {
        toast("先翻译出一个结果");
        return;
      }
      var pair =
        ui.translate.from === "zh"
          ? { en: b, zh: a, source: "manual" }
          : { en: a, zh: b, source: "manual" };
      var added = addWords([pair]);
      toast(added ? "已加入词库 🎉" : "这个词已经在词库里了");
      return;
    }
    if (act === "practice") {
      startPractice();
      return;
    }
    if (act === "quit-game") {
      quitGame();
      return;
    }
    if (act === "records-mode") {
      ui.recordsMode = el.getAttribute("data-value");
      render();
      return;
    }
    if (act === "month-prev" || act === "month-next") {
      var step = act === "month-prev" ? -1 : 1;
      var c = cursorMonth();
      ui.monthCursor = shiftMonth(c.year, c.month, step);
      render(true);
      return;
    }
    if (act === "month-now") {
      ui.monthCursor = null;
      render(true);
      return;
    }
    if (act === "year-prev" || act === "year-next") {
      ui.yearCursor = cursorYear() + (act === "year-prev" ? -1 : 1);
      render(true);
      return;
    }
    if (act === "year-now") {
      ui.yearCursor = null;
      render(true);
      return;
    }
    if (act === "goto-month") {
      ui.recordsMode = "month";
      ui.monthCursor = { year: cursorYear(), month: Number(el.getAttribute("data-month")) };
      render(true);
      return;
    }
    if (act === "theme") {
      state.theme = el.getAttribute("data-value") || "light";
      save();
      render();
      return;
    }
    if (act === "export") {
      exportData();
      return;
    }
    if (act === "import") {
      importData();
      return;
    }
    if (act === "clear") {
      clearAll();
      return;
    }
    if (act === "seed") {
      seedDemo();
      return;
    }
  }

  function handleGame(el) {
    var g = ui.game;
    if (!g || state.view !== "game") return;
    var action = el.getAttribute("data-game");
    if (action === "balloon") {
      tapBalloon(Number(el.getAttribute("data-index")));
      return;
    }
    if (action === "submit-spell") {
      var spellInput = $("#game-input");
      submitSpell(spellInput ? spellInput.value : "");
      return;
    }
    if (action === "submit-dict") {
      var input = $("#game-input");
      submitDictation(input ? input.value : "");
      return;
    }
    if (action === "speak") {
      if (g.words[g.index]) speak(g.words[g.index].en);
      return;
    }
    if (action === "reveal") {
      g.revealed = true;
      render();
      return;
    }
    if (action === "grade") {
      gradeReview(el.getAttribute("data-grade"));
      return;
    }
    if (action === "again") {
      if (g.mode === "balloon" || g.mode === "spell") {
        openWordPicker(g.mode);
        return;
      }
      if (g.mode === "review" && !dueReviewWords().length) {
        if (masteredWords().length) startPractice();
        else startMode("balloon");
      }
      else startMode(g.mode);
      return;
    }
    if (action === "home") {
      quitGame();
      return;
    }
  }

  document.addEventListener("click", function (e) {
    var actEl = e.target.closest("[data-act]");
    if (actEl) {
      handleAct(actEl);
      return;
    }
    var gameEl = e.target.closest("[data-game]");
    if (gameEl && state.view === "game") {
      handleGame(gameEl);
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || state.view !== "game") return;
    var input = e.target.closest("[data-game-input]");
    if (!input) return;
    e.preventDefault();
    var submit = input.getAttribute("data-submit");
    if (submit === "dict") submitDictation(input.value);
    else if (submit === "spell") submitSpell(input.value);
  });

  document.addEventListener("input", function (e) {
    var gameInput = e.target.closest("[data-game-input]");
    if (gameInput && state.view === "game") {
      updateTypingProgress();
      return;
    }
    var el = e.target.closest("[data-translate-input]");
    if (!el) return;
    ui.translate.input = el.value;
    scheduleTranslation();
  });

  document.addEventListener("change", function (e) {
    var el = e.target.closest("[data-setting]");
    if (!el) return;
    var key = el.getAttribute("data-setting");
    if (key === "dailyNew") {
      state.settings.dailyNew = clamp(Math.round(Number(el.value) || 8), 3, 30);
      save();
      render();
      toast("每天学习 " + state.settings.dailyNew + " 个新词");
    } else if (key === "sound") {
      state.settings.sound = el.value !== "0";
      save();
      render();
      toast(state.settings.sound ? "已开启发音" : "已关闭发音");
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeTopModal();
  });

  if (systemTheme) {
    var onSystemThemeChange = function () {
      if (state.theme === "system") render();
    };
    if (systemTheme.addEventListener) systemTheme.addEventListener("change", onSystemThemeChange);
    else if (systemTheme.addListener) systemTheme.addListener(onSystemThemeChange);
  }

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var bar = $(".tabbar");
      if (bar && bar.__sync) bar.__sync();
    }, 150);
  });

  var lastDayKey = dayKey(Date.now());
  function tick() {
    var now = Date.now();
    if (dayKey(now) !== lastDayKey) {
      lastDayKey = dayKey(now);
      if (state.view !== "game") render();
    }
  }

  var tickTimer = null;
  function startTick() {
    if (tickTimer === null) tickTimer = setInterval(tick, 1000);
  }
  function stopTick() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopTick();
    else {
      tick();
      startTick();
    }
  });
  startTick();

  render(true);
})();
