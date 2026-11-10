'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'telegramDL_userscript.js'), 'utf8');
const PEER = '777';
const OTHER_PEER = '888';
const MESSAGE_COUNT = 100;
const PAGE_SIZE = 20;
const MEDIA_EVERY = 3;
const SCROLL_HEIGHT = 2000;
const CLIENT_HEIGHT = 500;

function chatHistory() {
    const messages = new Map();
    for (let mid = 1; mid <= MESSAGE_COUNT; mid++) {
        const hasMedia = mid % MEDIA_EVERY === 0;
        messages.set(mid, hasMedia
            ? { mid, message: 'pic ' + mid, media: { photo: { id: mid } } }
            : { mid, message: 'text ' + mid });
    }
    return messages;
}

function mediaMids() {
    return Array.from(chatHistory().values()).filter((m) => m.media).map((m) => m.mid);
}

function fakeTelegram({ withScroller = true } = {}) {
    const dom = new JSDOM(
        '<!doctype html><html><head></head><body><div class="bubbles">' +
        (withScroller ? '<div class="scrollable scrollable-y"><div class="bubbles-inner"></div></div>' : '') +
        '</div></body></html>',
        { url: 'https://web.telegram.org/k/#@chat', runScripts: 'outside-only' },
    );
    const { window } = dom;
    const history = chatHistory();
    const downloads = [];
    const chat = { peerId: PEER };
    const view = { first: MESSAGE_COUNT - PAGE_SIZE + 1, last: MESSAGE_COUNT, top: CLIENT_HEIGHT, peer: PEER };

    window.setTimeout = (callback) => setImmediate(callback);
    window.mtprotoMessagePort = {
        getMessageByPeer: (peerId, mid) => (peerId === PEER ? history.get(mid) : undefined),
    };
    window.appDownloadManager = { downloadToDisc: async ({ media }) => { downloads.push(media.id); } };
    window.appImManager = { chat };

    const inner = window.document.querySelector('.bubbles-inner');
    const render = () => {
        inner.textContent = '';
        for (let mid = view.first; mid <= view.last; mid++) {
            const bubble = window.document.createElement('div');
            bubble.className = 'bubble';
            bubble.dataset.mid = String(mid);
            bubble.dataset.peerId = view.peer;
            inner.appendChild(bubble);
        }
    };

    if (withScroller) {
        const scroller = window.document.querySelector('.scrollable-y');
        Object.defineProperty(scroller, 'scrollHeight', { get: () => SCROLL_HEIGHT });
        Object.defineProperty(scroller, 'clientHeight', { get: () => CLIENT_HEIGHT });
        Object.defineProperty(scroller, 'scrollTop', {
            get: () => view.top,
            set: (value) => {
                view.top = value;
                if (value <= 0 && view.first > 1) {
                    view.first = Math.max(1, view.first - PAGE_SIZE);
                    view.last = Math.min(MESSAGE_COUNT, view.first + PAGE_SIZE * 2 - 1);
                    view.top = CLIENT_HEIGHT;
                } else if (value >= SCROLL_HEIGHT - CLIENT_HEIGHT && view.last < MESSAGE_COUNT) {
                    view.last = Math.min(MESSAGE_COUNT, view.last + PAGE_SIZE);
                    view.first = Math.max(1, view.last - PAGE_SIZE * 2 + 1);
                    view.top = CLIENT_HEIGHT;
                }
                render();
            },
        });
        render();
    }

    window.eval(SCRIPT);
    return { window, document: window.document, downloads, chat, view, render };
}

async function waitFor(condition, what) {
    for (let attempt = 0; attempt < 5000; attempt++) {
        const value = condition();
        if (value) return value;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('timed out waiting for ' + what);
}

function pickerRows(document) {
    return Array.from(document.querySelectorAll('#nk-tg-scan-list .nk-tg-row')).map((row) => row.textContent);
}

test('Scan all walks the whole chat, oldest first, and finds media that was never on screen at the start', async () => {
    const { document } = fakeTelegram();
    document.getElementById('nk-tg-scan-all').click();
    await waitFor(() => document.getElementById('nk-tg-scan-overlay'), 'the picker');
    const rows = pickerRows(document);
    assert.deepEqual(rows, mediaMids().map((mid) => 'pic ' + mid));
    assert.match(document.querySelector('.nk-tg-title').textContent, /33 found/);
    assert.equal(document.querySelector('.nk-tg-note').textContent, 'Whole chat scanned.');
});

test('the plain Scan button still only lists what is loaded now', async () => {
    const { document } = fakeTelegram();
    document.getElementById('nk-tg-scan').click();
    const rows = pickerRows(document);
    assert.deepEqual(rows, mediaMids().filter((mid) => mid > MESSAGE_COUNT - PAGE_SIZE).map((mid) => 'pic ' + mid));
});

test('Stop ends the scan early and says the list is partial', async () => {
    const { document } = fakeTelegram();
    document.getElementById('nk-tg-scan-all').click();
    const stop = await waitFor(() => document.getElementById('nk-tg-scan-stop'), 'the Stop button');
    stop.click();
    await waitFor(() => document.getElementById('nk-tg-scan-overlay'), 'the picker');
    assert.ok(pickerRows(document).length < mediaMids().length);
    assert.match(document.querySelector('.nk-tg-note').textContent, /Stopped early/);
    assert.equal(document.getElementById('nk-tg-scan-status'), null);
});

test('switching to another chat mid-scan stops it instead of mixing chats', async () => {
    const telegram = fakeTelegram();
    telegram.document.getElementById('nk-tg-scan-all').click();
    await waitFor(() => telegram.document.getElementById('nk-tg-scan-stop'), 'the scan to start');
    telegram.chat.peerId = OTHER_PEER;
    telegram.view.peer = OTHER_PEER;
    telegram.render();
    await waitFor(() => telegram.document.getElementById('nk-tg-scan-overlay'), 'the picker');
    assert.match(telegram.document.querySelector('.nk-tg-note').textContent, /chat changed/);
});

test('a second click while scanning does not start a second scan', async () => {
    const { document } = fakeTelegram();
    const button = document.getElementById('nk-tg-scan-all');
    button.click();
    await waitFor(() => document.getElementById('nk-tg-scan-stop'), 'the scan to start');
    button.click();
    assert.equal(document.querySelectorAll('#nk-tg-scan-status').length, 1);
    await waitFor(() => document.getElementById('nk-tg-scan-overlay'), 'the picker');
    assert.equal(document.querySelectorAll('#nk-tg-scan-overlay').length, 1);
});

test('Download Selected after Scan all downloads every checked item in chat order', async () => {
    const { document, downloads } = fakeTelegram();
    document.getElementById('nk-tg-scan-all').click();
    await waitFor(() => document.getElementById('nk-tg-scan-overlay'), 'the picker');
    document.getElementById('nk-tg-scan-go').click();
    await waitFor(() => !document.getElementById('nk-tg-scan-overlay'), 'the downloads to finish');
    assert.deepEqual(downloads, mediaMids());
});

test('Scan all says N/A when there is no chat open to scroll', async () => {
    const { document } = fakeTelegram({ withScroller: false });
    const button = document.getElementById('nk-tg-scan-all');
    button.click();
    assert.equal(button.textContent, 'N/A');
    assert.equal(document.getElementById('nk-tg-scan-status'), null);
});
