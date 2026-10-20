// 后台：代为下载图片、保存导出文件
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function saveDataUrl(dataUrl, filename, sendResponse) {
  chrome.downloads.download(
    { url: dataUrl, filename: filename, saveAs: false },
    (id) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, id });
      }
    }
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'draftExportFetchImage') {
    fetch(msg.url, { credentials: 'include' })
      .then(async (resp) => {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        sendResponse({
          ok: true,
          b64: arrayBufferToBase64(buf),
          mime: (resp.headers.get('Content-Type') || '').toLowerCase()
        });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'draftExportSaveFile') {
    const mime = msg.mime || 'application/octet-stream';
    saveDataUrl(`data:${mime};base64,${msg.b64}`, msg.filename, sendResponse);
    return true;
  }

  // 兼容旧版：保存 zip
  if (msg.type === 'draftExportSaveZip') {
    saveDataUrl('data:application/zip;base64,' + msg.b64, msg.filename, sendResponse);
    return true;
  }
});
