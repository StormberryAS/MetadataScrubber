"use strict";
/*! STORMBERRY FIRST-RUN GATE (behaviour). MetadataScrubber, dismissible tier.
    GENERATED FILE: build-gates.py at the root of the GitHub folder writes this TypeScript; a
    TypeScript app compiles it with its own build (tools/build-ts.sh), and for a JavaScript app
    build-gates.py compiles it with tsc. Edit build-gates.py and run it again; never edit gate.ts
    or gate.js. */
(function () {
    'use strict';
    const APP_ID = 'metadatascrubber';
    const VERSION = '2';
    const MANDATORY = false;
    const STORE_KEY = 'sb-gate:' + APP_ID + ':v' + VERSION;
    function alreadySeen() {
        try {
            return window.localStorage.getItem(STORE_KEY) !== null;
        }
        catch (err) {
            return false;
        }
    }
    function markSeen() {
        try {
            window.localStorage.setItem(STORE_KEY, new Date().toISOString());
        }
        catch (err) {
        }
    }
    if (alreadySeen())
        return;
    const TITLE_ID = 'sb-gate-title';
    const BODY_ID = 'sb-gate-body';
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const overlay = document.createElement('div');
    overlay.className = 'sb-gate-overlay';
    overlay.setAttribute('data-tier', MANDATORY ? 'mandatory' : 'dismissible');
    const dialog = document.createElement('div');
    dialog.className = 'sb-gate-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', TITLE_ID);
    dialog.setAttribute('aria-describedby', BODY_ID);
    dialog.tabIndex = -1;
    dialog.innerHTML = [
        '<p class="sb-gate-kicker">Prototype</p>',
        '<h2 class="sb-gate-title" id="' + TITLE_ID + '">Before you use MetadataScrubber</h2>',
        '<div class="sb-gate-scroll">',
        '<div class="sb-gate-body" id="' + BODY_ID + '">',
        '<p>This is a functioning prototype, published to show what Stormberry AS builds. It is not a certified instrument, not a professional service, and not a substitute for an authoritative source.</p>',
        '<p>It is <strong>not a finished product</strong>, it is not maintained as one, and <strong>it will eventually stop working</strong>: data moves, interfaces change, and nothing here is kept in step with them. Its purpose is to show a potential use of AI, making a possibility visible quickly so it can be judged and then built properly if it is worth building.</p>',
        '<p><strong>It removes only what it recognises.</strong> It removes the hidden information it recognises in JPEG, PNG, WebP and HEIC files. It cannot remove anything visible in the picture, the file name you choose, or the sensor fingerprint that can link photos to one camera.</p>',
        '<p>Check the read-back list of what remains in the new file before you share it.</p>',
        '</div>',
        '</div>',
        '<p class="sb-gate-ack">I understand this is a prototype. Its figures are calculated, not measured, and I will check anything important against an official source.</p>',
        '<div class="sb-gate-actions">',
        '<button type="button" class="sb-gate-btn">Got it</button>',
        '<a class="sb-gate-link" href="disclaimer.html">Read the full disclaimer</a>',
        '</div>'
    ].join('');
    overlay.appendChild(dialog);
    let previouslyFocused = null;
    let hidden = [];
    let nudgeTimer = 0;
    let pressedOnBackdrop = false;
    function focusables() {
        return Array.prototype.slice.call(dialog.querySelectorAll(FOCUSABLE));
    }
    function hideBackground() {
        const kids = Array.prototype.slice.call(document.body.children);
        kids.forEach(function (el) {
            if (el === overlay)
                return;
            hidden.push({ el: el, aria: el.getAttribute('aria-hidden') });
            el.setAttribute('aria-hidden', 'true');
            el.inert = true;
        });
    }
    function restoreBackground() {
        hidden.forEach(function (rec) {
            if (rec.aria === null) {
                rec.el.removeAttribute('aria-hidden');
            }
            else {
                rec.el.setAttribute('aria-hidden', rec.aria);
            }
            rec.el.inert = false;
        });
        hidden = [];
    }
    function nudge() {
        dialog.classList.remove('is-nudged');
        void dialog.offsetWidth;
        dialog.classList.add('is-nudged');
        window.clearTimeout(nudgeTimer);
        nudgeTimer = window.setTimeout(function () {
            dialog.classList.remove('is-nudged');
        }, 600);
    }
    function onKeydown(ev) {
        if (ev.key === 'Escape' || ev.key === 'Esc') {
            ev.preventDefault();
            if (MANDATORY) {
                nudge();
            }
            else {
                close();
            }
            return;
        }
        if (ev.key !== 'Tab')
            return;
        const items = focusables();
        if (items.length === 0) {
            ev.preventDefault();
            dialog.focus();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const here = document.activeElement;
        if (ev.shiftKey && (here === first || here === dialog)) {
            ev.preventDefault();
            last.focus();
        }
        else if (!ev.shiftKey && here === last) {
            ev.preventDefault();
            first.focus();
        }
    }
    function onFocusIn(ev) {
        if (!dialog.contains(ev.target)) {
            dialog.focus();
        }
    }
    function open() {
        previouslyFocused = document.activeElement;
        document.body.appendChild(overlay);
        hideBackground();
        document.documentElement.classList.add('sb-gate-open');
        document.addEventListener('keydown', onKeydown, true);
        document.addEventListener('focusin', onFocusIn, true);
        dialog.focus();
    }
    function close() {
        markSeen();
        window.clearTimeout(nudgeTimer);
        document.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('focusin', onFocusIn, true);
        document.documentElement.classList.remove('sb-gate-open');
        restoreBackground();
        if (overlay.parentNode)
            overlay.parentNode.removeChild(overlay);
        if (previouslyFocused && document.contains(previouslyFocused) &&
            typeof previouslyFocused.focus === 'function') {
            previouslyFocused.focus();
        }
        else if (document.body) {
            document.body.setAttribute('tabindex', '-1');
            document.body.focus();
            document.body.removeAttribute('tabindex');
        }
    }
    dialog.querySelector('.sb-gate-btn').addEventListener('click', close);
    overlay.addEventListener('pointerdown', function (ev) {
        pressedOnBackdrop = ev.target === overlay;
    });
    overlay.addEventListener('click', function (ev) {
        if (ev.target !== overlay)
            return;
        if (!pressedOnBackdrop)
            return;
        pressedOnBackdrop = false;
        if (MANDATORY) {
            nudge();
        }
        else {
            close();
        }
    });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', open, { once: true });
    }
    else {
        open();
    }
}());
