/* ================================================================
   STORMBERRY FIRST-RUN GATE (behaviour)
   MetadataScrubber, dismissible tier.

   GENERATED FILE. Do not edit this copy: it is overwritten. Edit
   build-gates.py at the root of the GitHub folder and re-run it, so
   every app stays in step.
================================================================ */
(function () {
  'use strict';

  var APP_ID = 'metadatascrubber';
  var VERSION = '2';
  var MANDATORY = false;

  /* The version rides in the key so that materially new wording re-prompts
     someone who already accepted the old wording. */
  var STORE_KEY = 'sb-gate:' + APP_ID + ':v' + VERSION;

  /* Storage throws outright in private mode and wherever the user has blocked
     it. We read that as "not seen yet" rather than failing: the gate keeps
     working, it simply cannot remember, so it shows again next visit. That is
     the safe direction to fail in for a warning. */
  function alreadySeen() {
    try {
      return window.localStorage.getItem(STORE_KEY) !== null;
    } catch (err) {
      return false;
    }
  }

  function markSeen() {
    try {
      window.localStorage.setItem(STORE_KEY, new Date().toISOString());
    } catch (err) {
      /* Nothing to do. The gate shows again next time, which is acceptable. */
    }
  }

  if (alreadySeen()) return;

  var TITLE_ID = 'sb-gate-title';
  var BODY_ID = 'sb-gate-body';
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  var overlay = document.createElement('div');
  overlay.className = 'sb-gate-overlay';
  overlay.setAttribute('data-tier', MANDATORY ? 'mandatory' : 'dismissible');

  var dialog = document.createElement('div');
  dialog.className = 'sb-gate-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', TITLE_ID);
  dialog.setAttribute('aria-describedby', BODY_ID);
  /* Focusable so the trap always has somewhere to put focus back. */
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

  var previouslyFocused = null;
  var hidden = [];
  var nudgeTimer = 0;
  var pressedOnBackdrop = false;

  function focusables() {
    return Array.prototype.slice.call(dialog.querySelectorAll(FOCUSABLE));
  }

  /* Everything else on the page is taken out of the tab order and out of the
     accessibility tree while the dialog is up. inert also kills pointer events,
     which is what makes "not usable until accepted" true rather than merely
     visual. aria-hidden covers the browsers that lack inert. */
  function hideBackground() {
    var kids = Array.prototype.slice.call(document.body.children);
    kids.forEach(function (el) {
      if (el === overlay) return;
      hidden.push({ el: el, aria: el.getAttribute('aria-hidden') });
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
    });
  }

  function restoreBackground() {
    hidden.forEach(function (rec) {
      if (rec.aria === null) {
        rec.el.removeAttribute('aria-hidden');
      } else {
        rec.el.setAttribute('aria-hidden', rec.aria);
      }
      rec.el.inert = false;
    });
    hidden = [];
  }

  /* Refusal needs to be felt, not silent. CSS decides whether that is a shake
     or, under prefers-reduced-motion, a still border flash. */
  function nudge() {
    dialog.classList.remove('is-nudged');
    /* Reading a layout property restarts the animation on a re-added class. */
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
      } else {
        close();
      }
      return;
    }

    if (ev.key !== 'Tab') return;

    var items = focusables();
    if (items.length === 0) {
      ev.preventDefault();
      dialog.focus();
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];
    var here = document.activeElement;
    if (ev.shiftKey && (here === first || here === dialog)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && here === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  /* Belt and braces for the trap: anything that lands focus outside the dialog,
     including content the app renders after the gate opened, is pulled back. */
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
    /* Focus the dialog itself rather than the first control. A screen reader
       then reads the title and the whole warning before it reaches the button,
       which is the point of the gate. Tab moves on to the links and the
       button from here. */
    dialog.focus();
  }

  function close() {
    markSeen();
    window.clearTimeout(nudgeTimer);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.documentElement.classList.remove('sb-gate-open');
    restoreBackground();
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);

    if (previouslyFocused && document.contains(previouslyFocused) &&
        typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    } else if (document.body) {
      /* Nothing sensible to return to, so park focus at the top of the page
         instead of leaving it on a removed node. */
      document.body.setAttribute('tabindex', '-1');
      document.body.focus();
      document.body.removeAttribute('tabindex');
    }
  }

  dialog.querySelector('.sb-gate-btn').addEventListener('click', close);

  /* The press has to both start and end on the backdrop, so a text selection
     dragged out of the dialog does not read as a dismissal. */
  overlay.addEventListener('pointerdown', function (ev) {
    pressedOnBackdrop = ev.target === overlay;
  });

  overlay.addEventListener('click', function (ev) {
    if (ev.target !== overlay) return;
    if (!pressedOnBackdrop) return;
    pressedOnBackdrop = false;
    if (MANDATORY) {
      nudge();
    } else {
      close();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', open, { once: true });
  } else {
    open();
  }
}());
