(function () {
  'use strict';

  var API_URL       = 'http://localhost:5000/api/transcript';
  var TRANSLATE_URL = 'http://localhost:5000/api/translate';

  var CACHE_KEY   = 'yt_transcript_history';
  var MAX_HISTORY = 5;

  // ── i18n ──────────────────────────────────────────────────
  var I18N = {
    zh: {
      subtitle:       'YouTube 字幕一键下载',
      urlLabel:       'YouTube 视频链接',
      urlPlaceholder: '请输入 YouTube 视频链接…',
      fetchBtn:       '获取字幕',
      loading:        '正在获取字幕，请稍候…',
      translateLabel: '翻译',
      translateBtn:   '翻译',
      translating:    '翻译中…',
      langZh:         '中文',
      downloadBtn:    '下载 transcript.txt',
      footer:         '仅供学习使用 \u2014 请遵守 YouTube 服务条款',
      errEmpty:       '请输入 YouTube 视频链接。',
      errNetwork:     '网络错误，无法连接到服务器。请确认 backend 已启动（python backend/app.py）。',
      errTransNet:    '翻译网络错误，无法连接到服务器。',
      noTranscript:   '暂无字幕内容。',
      historyLabel:   '最近记录',
      historyClear:   '清除',
      historyLoad:    '加载',
    },
    en: {
      subtitle:       'One-click YouTube Transcript Download',
      urlLabel:       'YouTube Video URL',
      urlPlaceholder: 'Enter a YouTube video URL…',
      fetchBtn:       'Get Transcript',
      loading:        'Fetching transcript, please wait…',
      translateLabel: 'Translate',
      translateBtn:   'Translate',
      translating:    'Translating…',
      langZh:         'Chinese',
      downloadBtn:    'Download transcript.txt',
      footer:         'For educational use only \u2014 Please comply with YouTube Terms of Service',
      errEmpty:       'Please enter a YouTube video URL.',
      errNetwork:     'Network error. Please make sure the backend is running (python backend/app.py).',
      errTransNet:    'Translation network error. Cannot connect to server.',
      noTranscript:   'No transcript content.',
      historyLabel:   'Recent',
      historyClear:   'Clear',
      historyLoad:    'Load',
    }
  };

  var currentLang = 'zh';

  function t(key) {
    return (I18N[currentLang] && I18N[currentLang][key]) || I18N['zh'][key] || key;
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
    document.title = currentLang === 'zh' ? 'YouTube 字幕下载' : 'YouTube Transcript DL';
    // Re-render history labels
    renderHistory();
  }

  function initLangSwitcher() {
    var btn   = document.getElementById('lang-switcher');
    var label = document.getElementById('lang-switcher-label');
    btn.addEventListener('click', function () {
      currentLang       = currentLang === 'zh' ? 'en' : 'zh';
      label.textContent = currentLang === 'zh' ? 'EN' : '中';
      applyI18n();
    });
  }

  // ── DOM refs ──────────────────────────────────────────────
  var urlInput         = document.getElementById('url-input');
  var fetchBtn         = document.getElementById('fetch-btn');
  var loading          = document.getElementById('loading');
  var errorMsg         = document.getElementById('error-msg');
  var errorText        = document.getElementById('error-text');
  var resultSection    = document.getElementById('result-section');
  var transcriptDiv    = document.getElementById('transcript-text');
  var downloadBtn      = document.getElementById('download-btn');
  var langInfo         = document.getElementById('lang-info');
  var translateToggle  = document.getElementById('translate-toggle');
  var langSelect       = document.getElementById('lang-select');
  var translateBtn     = document.getElementById('translate-btn');
  var translateLoading = document.getElementById('translate-loading');
  var historySection   = document.getElementById('history-section');
  var historyList      = document.getElementById('history-list');
  var historyClearBtn  = document.getElementById('history-clear-btn');
  var progressWrap     = document.getElementById('translate-progress-wrap');
  var progressBar      = document.getElementById('translate-progress-bar');

  // ── State ─────────────────────────────────────────────────
  var currentSegments           = [];
  var currentTranslatedSegments = null;
  var currentPlainText          = '';

  // ── Helpers ───────────────────────────────────────────────
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function extractErrorMsg(data, status) {
    if (data && data.error && data.error.message) return data.error.message;
    if (data && data.error && data.error.code)    return data.error.code;
    if (data && data.message)                     return data.message;
    return 'HTTP ' + status + '：请求失败。';
  }

  function setLoading(active) {
    if (active) {
      show(loading);
      fetchBtn.disabled = true;
      hide(errorMsg);
      hide(resultSection);
    } else {
      hide(loading);
      fetchBtn.disabled = false;
    }
  }

  function showError(msg) {
    errorText.textContent = msg || t('errNetwork');
    show(errorMsg);
  }

  // ── Progress Bar ──────────────────────────────────────────
  function startProgress() {
    progressBar.style.transition = 'none';
    progressBar.style.width = '0%';
    show(progressWrap);
    // Force reflow so the transition reset takes effect
    progressBar.offsetWidth;
    // Animate slowly to ~88% (simulating backend work over ~12 seconds)
    progressBar.style.transition = 'width 12s cubic-bezier(0.05, 0, 0.2, 1)';
    progressBar.style.width = '88%';
  }

  function finishProgress() {
    progressBar.style.transition = 'width 300ms ease-out';
    progressBar.style.width = '100%';
    setTimeout(function () {
      hide(progressWrap);
      progressBar.style.transition = 'none';
      progressBar.style.width = '0%';
    }, 500);
  }

  function resetProgress() {
    hide(progressWrap);
    progressBar.style.transition = 'none';
    progressBar.style.width = '0%';
  }

  // ── Local History (localStorage) ─────────────────────────
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveToHistory(url, data) {
    var history = loadHistory();
    // Remove duplicate URL entry
    history = history.filter(function (item) { return item.url !== url; });
    // Prepend newest
    history.unshift({
      url:           url,
      videoId:       data.video_id,
      language:      data.language,
      isAuto:        data.is_auto_generated,
      segmentsCount: data.segments ? data.segments.length : 0,
      data:          data,
      savedAt:       Date.now()
    });
    history = history.slice(0, MAX_HISTORY);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(history));
    } catch (e) {}
    renderHistory();
  }

  function clearHistory() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    renderHistory();
  }

  function renderHistory() {
    var history = loadHistory();
    if (history.length === 0) {
      hide(historySection);
      return;
    }
    show(historySection);
    historyList.innerHTML = '';
    history.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'history-item';

      var info = document.createElement('div');
      info.className = 'history-info';

      var vid = document.createElement('span');
      vid.className = 'history-vid';
      vid.textContent = item.videoId || item.url;

      var meta = document.createElement('span');
      meta.className = 'history-meta';
      var autoLabel = item.isAuto ? (currentLang === 'zh' ? '自动' : 'auto') : (currentLang === 'zh' ? '人工' : 'manual');
      meta.textContent = (item.language || '?') + ' · ' + autoLabel + ' · ' + (item.segmentsCount || 0) + (currentLang === 'zh' ? ' 句' : ' segs');

      info.appendChild(vid);
      info.appendChild(meta);

      var loadBtn = document.createElement('button');
      loadBtn.className = 'history-load-btn';
      loadBtn.textContent = t('historyLoad');
      loadBtn.addEventListener('click', (function (captured) {
        return function () {
          urlInput.value = captured.url;
          hide(errorMsg);
          showResult(captured.data);
        };
      })(item));

      row.appendChild(info);
      row.appendChild(loadBtn);
      historyList.appendChild(row);
    });
  }

  historyClearBtn.addEventListener('click', clearHistory);

  // ── Lang badges ───────────────────────────────────────────
  function buildLangBadges(data) {
    langInfo.innerHTML = '';

    if (data.language) {
      var langBadge = document.createElement('span');
      langBadge.className = 'badge';
      var dot1 = document.createElement('span');
      dot1.className = 'badge-dot';
      langBadge.appendChild(dot1);
      langBadge.appendChild(document.createTextNode(data.language));
      langInfo.appendChild(langBadge);
    }

    var isAuto = data.is_auto_generated === true;
    var autoBadge = document.createElement('span');
    autoBadge.className = 'badge ' + (isAuto ? 'auto' : 'manual');
    var dot2 = document.createElement('span');
    dot2.className = 'badge-dot';
    autoBadge.appendChild(dot2);
    autoBadge.appendChild(document.createTextNode(isAuto ? '自动生成字幕' : '人工字幕'));
    langInfo.appendChild(autoBadge);
  }

  // ── Render segments ───────────────────────────────────────
  function renderSegments(segments) {
    transcriptDiv.innerHTML = '';

    if (!segments || segments.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#555;padding:12px 0;';
      empty.textContent = t('noTranscript');
      transcriptDiv.appendChild(empty);
      return;
    }

    var frag = document.createDocumentFragment();

    segments.forEach(function (seg) {
      var row = document.createElement('div');
      row.className = 'segment';

      var timeSpan = document.createElement('span');
      timeSpan.className = 'seg-time';
      timeSpan.textContent = seg.timestamp || '';

      var textSpan = document.createElement('span');
      textSpan.className = 'seg-text';
      textSpan.textContent = seg.text || '';

      if (seg.translated_text) {
        var transSpan = document.createElement('span');
        transSpan.className = 'seg-translated';
        transSpan.textContent = seg.translated_text;
        textSpan.appendChild(transSpan);
      }

      row.appendChild(timeSpan);
      row.appendChild(textSpan);
      frag.appendChild(row);
    });

    transcriptDiv.appendChild(frag);
  }

  // ── Build download text ───────────────────────────────────
  function buildDownloadText(segments) {
    if (!segments || segments.length === 0) return '';
    return segments.map(function (seg) {
      var line = '[' + (seg.timestamp || '') + '] ' + (seg.text || '');
      if (seg.translated_text) line += '\n' + seg.translated_text;
      return line;
    }).join('\n');
  }

  // ── Show result ───────────────────────────────────────────
  function showResult(data) {
    currentTranslatedSegments = null;
    translateToggle.checked = false;
    hide(langSelect);
    hide(translateBtn);
    hide(translateLoading);
    resetProgress();

    currentSegments  = Array.isArray(data.segments) ? data.segments : [];
    currentPlainText = data.plain_text || buildDownloadText(currentSegments);

    renderSegments(currentSegments);
    buildLangBadges(data);
    show(resultSection);
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Translate toggle ──────────────────────────────────────
  translateToggle.addEventListener('change', function () {
    if (translateToggle.checked) {
      show(langSelect);
      show(translateBtn);
    } else {
      hide(langSelect);
      hide(translateBtn);
      hide(translateLoading);
      resetProgress();
      currentTranslatedSegments = null;
      renderSegments(currentSegments);
      currentPlainText = buildDownloadText(currentSegments);
    }
  });

  // ── Translate button ──────────────────────────────────────
  translateBtn.addEventListener('click', function () {
    if (!currentSegments || currentSegments.length === 0) return;

    show(translateLoading);
    translateBtn.disabled = true;
    startProgress();

    fetch(TRANSLATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segments: currentSegments,
        target_language: langSelect.value
      })
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, status: res.status, json: json };
        });
      })
      .then(function (result) {
        hide(translateLoading);
        translateBtn.disabled = false;
        finishProgress();

        if (!result.ok || !result.json.success) {
          showError(extractErrorMsg(result.json, result.status));
          return;
        }

        var translatedSegs = result.json.data && result.json.data.segments
          ? result.json.data.segments
          : [];

        currentTranslatedSegments = translatedSegs;
        renderSegments(translatedSegs);
        currentPlainText = buildDownloadText(translatedSegs);
      })
      .catch(function (err) {
        hide(translateLoading);
        translateBtn.disabled = false;
        resetProgress();
        showError(t('errTransNet'));
      });
  });

  // ── Fetch transcript ──────────────────────────────────────
  function fetchTranscript() {
    var url = urlInput.value.trim();
    if (!url) { urlInput.focus(); showError(t('errEmpty')); return; }

    setLoading(true);

    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, status: res.status, json: json };
        });
      })
      .then(function (result) {
        setLoading(false);
        if (!result.ok || !result.json.success) {
          showError(extractErrorMsg(result.json, result.status));
          return;
        }
        var data = result.json.data;
        saveToHistory(url, data);
        showResult(data);
      })
      .catch(function () {
        setLoading(false);
        showError(t('errNetwork'));
      });
  }

  // ── Download ──────────────────────────────────────────────
  downloadBtn.addEventListener('click', function () {
    var text = currentPlainText;
    if (!text) return;
    var blob    = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var blobUrl = URL.createObjectURL(blob);
    var a       = document.createElement('a');
    a.href      = blobUrl;
    a.download  = 'transcript.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 10000);
  });

  // ── Events ────────────────────────────────────────────────
  fetchBtn.addEventListener('click', fetchTranscript);
  urlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') fetchTranscript();
  });
  urlInput.addEventListener('input', function () {
    if (!errorMsg.classList.contains('hidden')) hide(errorMsg);
  });

  initLangSwitcher();
  applyI18n();
  renderHistory();
})();
