// ==UserScript==
// @name         Telegram Web Media Downloader
// @author       drew-codes-things
// @version      1.0.1
// @description  Download photos and videos from Telegram Web, one by one, in batches, or via a chat-wide scan-and-pick list - even in restricted "no-forwards" chats. Also re-enables copying text from protected messages.
// @match        https://web.telegram.org/*
// @match        https://webk.telegram.org/*
// @match        https://webz.telegram.org/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const onWebK = location.hostname === 'webk.telegram.org' || location.pathname.startsWith('/k/');
    if (!onWebK) {
        location.replace('https://web.telegram.org/k/' + location.hash);
        return;
    }

    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const BATCH_GAP_MS = 1000;
    const BATCH_LABEL = 'Download';

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const mediaOf = (msg) => msg && msg.media && (msg.media.document || msg.media.photo);
    const lookup = (peerId, mid) => page.mtprotoMessagePort?.getMessageByPeer(peerId, +mid);
    const escapeHtml = (str) => str.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    async function download(msg) {
        const media = mediaOf(msg);
        const dm = page.appDownloadManager;
        if (!dm) { console.warn('[tg-save] appDownloadManager missing - WebK internals changed?'); return; }
        if (media) await dm.downloadToDisc({ media });
    }

    async function downloadMany(messages, limit, onProgress) {
        let index = 0;
        let done = 0;
        async function lane() {
            while (index < messages.length) {
                const msg = messages[index++];
                try { await download(msg); } catch (err) { console.warn('[tg-save] download failed', err); }
                done++;
                onProgress?.(done, messages.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, messages.length) }, lane));
    }

    let pending = null;

    document.addEventListener('mouseup', (e) => {
        pending = null;
        if (e.button !== 2) return;
        const bubble = e.target.closest('[data-mid]');
        if (!bubble || !bubble.closest('.no-forwards')) return;
        if (mediaOf(lookup(bubble.dataset.peerId, bubble.dataset.mid))) {
            pending = { peerId: bubble.dataset.peerId, mid: bubble.dataset.mid };
        }
    });

    function addDownloadItem(menu) {
        const first = menu.querySelector('.btn-menu-item');
        if (!pending || !first || menu.querySelector('#nk-tg-down')) return;
        const { peerId, mid } = pending;
        first.insertAdjacentHTML('beforebegin',
            '<div class="btn-menu-item rp-overflow" id="nk-tg-down">' +
            '<span class="btn-menu-item-text">Download</span></div>');
        menu.querySelector('#nk-tg-down').addEventListener('click',
            () => download(lookup(peerId, mid)).catch((err) => console.warn('[tg-save] download failed', err)));
    }

    function addBatchButton(wrapper) {
        const bar = wrapper.querySelector('.selection-container');
        if (!bar || bar.querySelector('#nk-tg-batch')) return;
        bar.insertAdjacentHTML('beforeend',
            '<button id="nk-tg-batch" class="btn-primary btn-transparent text-bold" title="Download selected media" style="cursor:pointer;width:auto;">' +
            '<span class="nk-txt">' + BATCH_LABEL + '</span></button>');
        bar.querySelector('#nk-tg-batch').addEventListener('click', downloadSelected);
    }

    async function downloadSelected() {
        const sel = page.appImManager?.chat?.selection;
        const txt = document.querySelector('#nk-tg-batch .nk-txt');
        const media = ((await sel?.getSelectedMessages()) || []).filter(mediaOf);
        if (!media.length) { txt.textContent = 'N/A'; await delay(1500); txt.textContent = BATCH_LABEL; return; }

        const btn = document.getElementById('nk-tg-batch');
        btn.disabled = true; btn.style.opacity = 0.6;
        for (let i = 0; i < media.length; i++) {
            txt.textContent = (i + 1) + '/' + media.length;
            try { await download(media[i]); } catch (err) { console.warn('[tg-save] batch item failed', err); }
            if (i < media.length - 1) await delay(BATCH_GAP_MS);
        }
        btn.disabled = false; btn.style.opacity = 1; txt.textContent = BATCH_LABEL;
        sel?.cancelSelection();
    }

    function getChatBubbles() {
        return Array.from(document.querySelectorAll('.bubbles [data-mid]'));
    }

    function describeMedia(msg) {
        const caption = (msg.message || '').trim();
        if (caption) return caption;
        const media = mediaOf(msg);
        if (media?.file_name) return media.file_name;
        if (msg.media?.photo) return 'Photo';
        return media?.type === 'video' ? 'Video' : (media?.type || 'File');
    }

    function scanChatMedia() {
        const seen = new Set();
        const found = [];
        for (const bubble of getChatBubbles()) {
            const { peerId, mid } = bubble.dataset;
            const key = peerId + ':' + mid;
            if (seen.has(key)) continue;
            seen.add(key);
            const msg = lookup(peerId, mid);
            if (!mediaOf(msg)) continue;
            found.push({ msg, name: describeMedia(msg) });
        }
        return found;
    }

    function openScanPicker(items) {
        const overlay = document.createElement('div');
        overlay.id = 'nk-tg-scan-overlay';

        const rows = items.map((item, i) =>
            '<label class="nk-tg-row">' +
            '<input type="checkbox" class="nk-scan-item" data-i="' + i + '" checked>' +
            '<span>' + escapeHtml(item.name) + '</span></label>'
        ).join('');

        overlay.innerHTML =
            '<div class="nk-tg-panel">' +
            '<div class="nk-tg-title">Select media to download (' + items.length + ' found)</div>' +
            '<div id="nk-tg-scan-list">' + rows + '</div>' +
            '<div class="nk-tg-actions">' +
            '<button id="nk-tg-scan-cancel" class="nk-tg-btn nk-tg-btn-secondary">Cancel</button>' +
            '<button id="nk-tg-scan-go" class="nk-tg-btn">Download Selected</button>' +
            '</div></div>';

        document.body.appendChild(overlay);

        overlay.addEventListener('mousedown', (e) => e.stopPropagation());
        overlay.addEventListener('click', (e) => e.stopPropagation());
        overlay.querySelector('#nk-tg-scan-list').addEventListener('click', (e) => {
            const label = e.target.closest('label');
            const cb = label?.querySelector('.nk-scan-item');
            if (!cb) return;
            e.preventDefault();
            cb.checked = !cb.checked;
        });

        overlay.querySelector('#nk-tg-scan-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#nk-tg-scan-go').addEventListener('click', async () => {
            const goBtn = overlay.querySelector('#nk-tg-scan-go');
            const checked = Array.from(overlay.querySelectorAll('.nk-scan-item:checked'))
                .map((cb) => items[+cb.dataset.i].msg);
            if (!checked.length) return;

            goBtn.disabled = true;
            overlay.querySelector('#nk-tg-scan-cancel').disabled = true;
            await downloadMany(checked, 1, (done, total) => {
                goBtn.textContent = done + '/' + total;
            });
            overlay.remove();
        });
    }

    function addScanButton() {
        if (document.getElementById('nk-tg-scan')) return;
        const btn = document.createElement('button');
        btn.id = 'nk-tg-scan';
        btn.title = 'Scan chat for media to download';
        btn.textContent = 'Scan';
        btn.addEventListener('click', () => {
            const items = scanChatMedia();
            if (!items.length) {
                btn.textContent = 'N/A';
                setTimeout(() => { btn.textContent = 'Scan'; }, 1500);
                return;
            }
            openScanPicker(items);
        });
        document.body.appendChild(btn);
    }

    document.addEventListener('copy', (e) => {
        const node = getSelection()?.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (el?.closest('.no-forwards')) e.stopImmediatePropagation();
    }, true);

    const GRADIENT_STYLE = `
#nk-tg-scan {
    position: fixed; bottom: 5rem; right: 1.5rem; z-index: 9999; height: 2.5rem; padding: 0 1.1rem;
    border-radius: 999px; border: 1px solid transparent; cursor: pointer;
    background: linear-gradient(135deg, #e5383b, #7a0f14); color: #fff;
    font: 500 .9rem 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    box-shadow: 0 16px 40px rgba(0, 0, 0, .45); transition: filter .15s ease;
}
#nk-tg-scan:hover { filter: brightness(1.12); }
#nk-tg-scan-overlay {
    position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, .55); backdrop-filter: blur(4px);
}
.nk-tg-panel {
    max-width: 28rem; max-height: 80vh; overflow: auto; padding: 1.1rem 1.2rem;
    background: radial-gradient(120% 70% at 0% 0%, rgba(160, 20, 28, .38), transparent 60%), linear-gradient(165deg, #1c0608 0%, #0d0b0c 42%, #070708 100%);
    color: #ececec; border: 1px solid rgba(255, 255, 255, .14); border-radius: 16px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, .45);
    font: .9rem/1.5 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
}
.nk-tg-title { font-weight: 600; margin-bottom: .6rem; color: #f5c2c3; }
.nk-tg-row {
    display: flex; align-items: flex-start; gap: .5rem; padding: .35rem .5rem; overflow-wrap: anywhere;
    border-radius: 10px; cursor: pointer;
}
.nk-tg-row:hover { background: rgba(255, 255, 255, .07); }
.nk-tg-row input { accent-color: #e5383b; margin-top: .25rem; }
.nk-tg-actions { display: flex; gap: .5rem; margin-top: 1rem; justify-content: flex-end; }
.nk-tg-btn {
    padding: .5rem 1rem; border-radius: 12px; border: 1px solid transparent; cursor: pointer; color: #fff;
    background: linear-gradient(135deg, #e5383b, #7a0f14); font-family: inherit; font-size: .85rem; font-weight: 500;
    transition: filter .15s ease;
}
.nk-tg-btn:hover { filter: brightness(1.12); }
.nk-tg-btn:disabled { opacity: .6; cursor: default; filter: none; }
.nk-tg-btn-secondary { background: rgba(255, 255, 255, .07); border-color: rgba(255, 255, 255, .14); color: #a1a1a6; }
.nk-tg-btn-secondary:hover { filter: none; background: rgba(255, 255, 255, .11); color: #ececec; }
@media (prefers-reduced-motion: reduce) { #nk-tg-scan, .nk-tg-btn { transition: none; } }
`;

    const style = document.createElement('style');
    style.textContent = '.bubble.no-forwards,.bubble.no-forwards *' +
        '{-webkit-user-select:text!important;user-select:text!important}' + GRADIENT_STYLE;
    (document.head || document.documentElement).appendChild(style);

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.id === 'bubble-contextmenu') addDownloadItem(node);
                else if (node.classList.contains('selection-wrapper')) addBatchButton(node);
            }
        }
    });
    const start = () => {
        observer.observe(document.body, { childList: true, subtree: true });
        addScanButton();
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
