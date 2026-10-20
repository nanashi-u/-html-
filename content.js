// 公众号草稿导出 / 导入 · 内容脚本
(() => {
  'use strict';
  if (window.__wxDraftToolInjected) return;
  window.__wxDraftToolInjected = true;

  const PANEL_ID = 'wx-draft-tool-panel';
  const BTN_EXPORT_HTML = 'wx-draft-export-html';
  const BTN_EXPORT_ZIP = 'wx-draft-export-zip';
  const BTN_IMPORT = 'wx-draft-import';
  const BTN_COPY = 'wx-draft-copy-code';
  const BTN_BAR = 'wx-draft-tool-bar';

  let exporting = false;
  let panelBuilt = false;

  const isEditPage = () => /appmsg_edit/.test(location.href) || /[?&]action=edit/.test(location.href);

  // ---------- 通用工具 ----------
  function findBody() {
    const iframe = document.querySelector('iframe.edui-body-container, #ueditor_0');
    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
      return iframe.contentDocument.body;
    }
    const eds = [...document.querySelectorAll('[contenteditable="true"]')];
    if (!eds.length) return null;
    return eds.sort((a, b) => b.innerHTML.length - a.innerHTML.length)[0];
  }

  function getTitle() {
    const direct = document.querySelector('.title-editor__input, .js_title_place, textarea.js_title');
    if (direct) {
      const t = (direct.innerText || direct.value || '').trim();
      if (t) return t.split('\n')[0].slice(0, 100);
    }
    const eds = [...document.querySelectorAll('[contenteditable="true"]')]
      .sort((a, b) => a.innerHTML.length - b.innerHTML.length);
    for (const el of eds) {
      const t = (el.innerText || '').trim();
      if (t && t.length < 120) return t.split('\n')[0].trim();
    }
    return '公众号草稿';
  }

  function prepareHtml(rawHtml) {
    const doc = new DOMParser().parseFromString(
      '<!DOCTYPE html><html><body><div id="__wx_root">' + rawHtml + '</div></body></html>',
      'text/html'
    );
    const root = doc.getElementById('__wx_root');
    root.querySelectorAll('.ProseMirror-separator, br.ProseMirror-trailingBreak').forEach(el => el.remove());
    root.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
    root.querySelectorAll('span[leaf]').forEach(el => el.removeAttribute('leaf'));
    root.querySelectorAll('img').forEach(img => {
      img.removeAttribute('data-src');
      img.removeAttribute('data-imgfileid');
      img.removeAttribute('data-aistatus');
      img.removeAttribute('contenteditable');
      const cls = (img.getAttribute('class') || '')
        .split(/\s+/).filter(c => c && !/^(ProseMirror|js_insertlocalimg)/.test(c)).join(' ');
      if (cls) img.setAttribute('class', cls); else img.removeAttribute('class');
    });

    const imgs = [...root.querySelectorAll('img')].filter(i => i.getAttribute('src'));
    const urls = [];
    const seen = new Set();
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (!/^https?:\/\//i.test(src)) continue;
      if (!seen.has(src)) { seen.add(src); urls.push(src); }
    }
    return { root, imgs, urls };
  }

  function pickExt(mime, url) {
    const m = (mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('gif')) return 'gif';
    if (m.includes('webp')) return 'webp';
    if (m.includes('svg')) return 'svg';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    const hit = url.match(/wx_fmt=([a-z]+)/i);
    if (hit) {
      const e = hit[1].toLowerCase();
      return e === 'jpeg' ? 'jpg' : e;
    }
    return 'jpg';
  }

  function fetchImage(url) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'draftExportFetchImage', url }, resp => {
        if (chrome.runtime.lastError || !resp || !resp.ok) resolve(null);
        else resolve(resp);
      });
    });
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function u8ToB64(u8) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function buildDoc(title, bodyHtml) {
    const safeTitle = String(title).replace(/[<>&]/g, s => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[s]));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  body { max-width: 677px; margin: 0 auto; padding: 20px 16px 40px; background: #fff;
         font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
         color: #333; line-height: 1.8; }
  img { max-width: 100%; height: auto; }
  section, div { box-sizing: border-box; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  function safeFilename(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '公众号草稿';
  }

  function saveFile(b64, filename, mime) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'draftExportSaveFile', b64, filename, mime }, resp => {
        resolve(!!(resp && resp.ok));
      });
    });
  }

  // ---------- 按钮 ----------
  function setBtn(id, text, disabled) {
    const b = document.getElementById(id);
    if (!b) return;
    b.textContent = text;
    b.disabled = !!disabled;
    b.style.opacity = disabled ? '0.7' : '1';
    b.style.cursor = disabled ? 'wait' : 'pointer';
  }

  const defaultText = id => {
    if (id === BTN_EXPORT_HTML) return '导出 HTML';
    if (id === BTN_EXPORT_ZIP) return '导出 ZIP';
    if (id === BTN_COPY) return '复制代码';
    return '导入 HTML';
  };

  function flash(id, text, ms = 2400) {
    setBtn(id, text, false);
    setTimeout(() => setBtn(id, defaultText(id), false), ms);
  }

  function styleBtn(primary) {
    return [
      'padding:9px 16px', 'border-radius:20px',
      'font-size:13px', 'font-weight:600', 'letter-spacing:0.5px',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',
      'cursor:pointer', 'box-shadow:0 4px 14px rgba(0,0,0,.14)',
      primary ? 'background:#B01C2E;color:#fff;border:none'
              : 'background:#fff;color:#B01C2E;border:1px solid #E4B7BE'
    ].join(';');
  }

  function makeBar() {
    const bar = document.createElement('div');
    bar.id = BTN_BAR;
    bar.style.cssText = [
      'position:fixed', 'right:24px', 'bottom:132px', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'gap:8px', 'align-items:flex-end'
    ].join(';');

    const mk = (id, label, primary, handler) => {
      const b = document.createElement('button');
      b.id = id;
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = styleBtn(primary);
      b.addEventListener('click', handler);
      bar.appendChild(b);
      return b;
    };

    mk(BTN_EXPORT_HTML, '导出 HTML', true, () => exportDraft('html'));
    mk(BTN_COPY, '复制代码', false, copyCode);
    mk(BTN_EXPORT_ZIP, '导出 ZIP', false, () => exportDraft('zip'));
    mk(BTN_IMPORT, '导入 HTML', false, openImportPanel);

    document.body.appendChild(bar);
    return bar;
  }

  function refresh() {
    const bar = document.getElementById(BTN_BAR);
    if (!isEditPage()) {
      if (bar) bar.style.display = 'none';
      return;
    }
    const b = bar || makeBar();
    b.style.display = 'flex';
  }

  // ---------- 导出 ----------
  async function exportDraft(mode) {
    if (exporting) return;
    const bodyEl = findBody();
    if (!bodyEl || !bodyEl.innerHTML.trim()) {
      alert('没有找到正文内容。请先打开一篇草稿，等编辑器加载完成后再点导出。');
      return;
    }

    exporting = true;
    const mainBtn = mode === 'html' ? BTN_EXPORT_HTML : BTN_EXPORT_ZIP;
    const otherBtn = mode === 'html' ? BTN_EXPORT_ZIP : BTN_EXPORT_HTML;
    setBtn(mainBtn, '准备中…', true);
    setBtn(otherBtn, defaultText(otherBtn), true);
    setBtn(BTN_IMPORT, defaultText(BTN_IMPORT), true);
    setBtn(BTN_COPY, defaultText(BTN_COPY), true);

    try {
      const title = getTitle();
      const prepared = prepareHtml(bodyEl.innerHTML);

      if (mode === 'html') {
        for (let i = 0; i < prepared.urls.length; i++) {
          setBtn(mainBtn, `内嵌图片 ${i + 1}/${prepared.urls.length}…`, true);
          const url = prepared.urls[i];
          const resp = await fetchImage(url);
          if (!resp) continue;
          const mime = resp.mime && resp.mime.startsWith('image/') ? resp.mime : 'image/jpeg';
          const dataUri = `data:${mime};base64,${resp.b64}`;
          prepared.imgs.forEach(img => {
            if (img.getAttribute('src') === url) img.setAttribute('src', dataUri);
          });
        }
        const doc = buildDoc(title, prepared.root.innerHTML);
        setBtn(mainBtn, '保存中…', true);
        const ok = await saveFile(
          u8ToB64(new TextEncoder().encode(doc)),
          safeFilename(title) + '.html',
          'text/html;charset=utf-8'
        );
        if (!ok) throw new Error('下载失败');
        flash(mainBtn, '已导出 ✓');
      } else {
        const files = [];
        const saved = new Map();
        for (let i = 0; i < prepared.urls.length; i++) {
          setBtn(mainBtn, `下载图片 ${i + 1}/${prepared.urls.length}…`, true);
          const url = prepared.urls[i];
          const resp = await fetchImage(url);
          if (!resp) continue;
          const ext = pickExt(resp.mime, url);
          const name = `images/img-${i + 1}.${ext}`;
          files.push({ name, data: b64ToU8(resp.b64) });
          saved.set(url, name);
        }
        prepared.imgs.forEach(img => {
          const src = img.getAttribute('src');
          if (saved.has(src)) img.setAttribute('src', saved.get(src));
        });
        files.unshift({ name: 'index.html', data: new TextEncoder().encode(buildDoc(title, prepared.root.innerHTML)) });
        const zipData = makeZip(files);
        setBtn(mainBtn, '保存中…', true);
        const ok = await saveFile(
          u8ToB64(zipData),
          safeFilename(title) + '_草稿导出.zip',
          'application/zip'
        );
        if (!ok) throw new Error('下载失败');
        flash(mainBtn, '已导出 ✓');
      }
    } catch (err) {
      console.error('[草稿工具]', err);
      alert('导出失败：' + (err && err.message ? err.message : err));
      setBtn(mainBtn, defaultText(mainBtn), false);
    } finally {
      exporting = false;
      setBtn(otherBtn, defaultText(otherBtn), false);
      setBtn(BTN_IMPORT, defaultText(BTN_IMPORT), false);
      setBtn(BTN_COPY, defaultText(BTN_COPY), false);
    }
  }


  // ---------- 复制代码 ----------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return ok;
  }

  async function copyCode() {
    const bodyEl = findBody();
    if (!bodyEl || !bodyEl.innerHTML.trim()) {
      alert('没有找到正文内容，请先打开一篇草稿。');
      return;
    }
    setBtn(BTN_COPY, '生成中…', true);
    try {
      const title = getTitle();
      const prepared = prepareHtml(bodyEl.innerHTML);
      const doc = buildDoc(title, prepared.root.innerHTML);
      const ok = await copyText(doc);
      if (!ok) throw new Error('剪贴板不可用');
      flash(BTN_COPY, '已复制 ✓', 2200);
    } catch (err) {
      alert('复制失败：' + (err && err.message ? err.message : err));
      setBtn(BTN_COPY, defaultText(BTN_COPY), false);
    }
  }

  // ---------- 导入 ----------
  function openImportPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'background:rgba(0,0,0,.45)', 'display:flex', 'align-items:center', 'justify-content:center'
      ].join(';');
      panel.innerHTML = `
        <div style="width:560px;max-width:92vw;max-height:86vh;background:#fff;border-radius:12px;
                    box-shadow:0 18px 50px rgba(0,0,0,.3);overflow:hidden;display:flex;flex-direction:column;">
          <div style="padding:16px 20px;background:#B01C2E;color:#fff;font-size:14px;font-weight:600;">
            导入 HTML 到当前草稿
          </div>
          <div style="padding:14px 20px 0;font-size:12px;color:#888;line-height:1.6;">
            粘贴带内联样式的 HTML（完整文档或片段均可）。图片若是微信 CDN 链接可直接用；外链图片发表后可能失效。
          </div>
          <textarea id="wx-draft-import-text" placeholder="在此粘贴 HTML 代码…"
            style="margin:12px 20px 0;padding:10px;height:300px;resize:vertical;border:1px solid #ddd;
                   border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:12px;line-height:1.5;"></textarea>
          <div style="padding:14px 20px 18px;display:flex;gap:10px;justify-content:flex-end;">
            <button id="wx-draft-import-cancel" style="padding:8px 16px;border:1px solid #ddd;background:#fff;
                    border-radius:8px;cursor:pointer;font-size:13px;">取消</button>
            <button id="wx-draft-import-insert" style="padding:8px 16px;border:1px solid #E4B7BE;background:#fff;
                    color:#B01C2E;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">插入到光标处</button>
            <button id="wx-draft-import-replace" style="padding:8px 16px;border:none;background:#B01C2E;color:#fff;
                    border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">替换全文</button>
          </div>
        </div>`;
      panel.addEventListener('click', e => { if (e.target === panel) closePanel(); });
      document.body.appendChild(panel);
      panel.querySelector('#wx-draft-import-cancel').addEventListener('click', closePanel);
      panel.querySelector('#wx-draft-import-insert').addEventListener('click', () => doImport(false));
      panel.querySelector('#wx-draft-import-replace').addEventListener('click', () => doImport(true));
    }
    panel.style.display = 'flex';
    const ta = panel.querySelector('#wx-draft-import-text');
    ta.value = '';
    ta.focus();
  }

  function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';
  }

  function doImport(replaceAll) {
    const ta = document.getElementById('wx-draft-import-text');
    const html = (ta && ta.value || '').trim();
    if (!html) { alert('请先粘贴 HTML 代码'); return; }

    const editor = findBody();
    if (!editor) { alert('没有找到正文编辑器'); return; }

    editor.focus();
    if (replaceAll) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
    }

    const before = editor.innerHTML.length;
    let ok = false;
    try {
      ok = document.execCommand('insertHTML', false, html);
    } catch (e) {
      ok = false;
    }

    // 兜底：模拟一次 paste，让编辑器自己解析
    if (!ok || editor.innerHTML.length === before) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/html', html);
        dt.setData('text/plain', html.replace(/<[^>]+>/g, '').trim());
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
        editor.dispatchEvent(ev);
        ok = editor.innerHTML.length !== before;
      } catch (e) {
        ok = false;
      }
    }

    editor.dispatchEvent(new Event('input', { bubbles: true }));
    closePanel();
    if (!ok) alert('插入可能未成功，请检查正文。');
  }

  refresh();
  setInterval(refresh, 1500);
})();
