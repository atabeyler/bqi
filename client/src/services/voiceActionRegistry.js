// Global action registry — each component registers its own semantic actions here.
// A small universal accessibility layer is also exposed so the assistant can
// operate controls that do not yet need a bespoke component action.
import { CRITICAL_ACTIONS } from './voiceIntentSchema.js';

const registry = new Map(); // scope -> Action[]

const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase('tr-TR');

function visible(el) {
  if (!el || el.disabled) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
}

function labelOf(el) {
  return [
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('title'),
    el.getAttribute?.('placeholder'),
    el.getAttribute?.('name'),
    el.getAttribute?.('data-voice-label'),
    el.innerText,
    el.textContent,
  ].filter(Boolean).join(' ');
}

function candidates(selector = '') {
  if (selector) {
    try { return Array.from(document.querySelectorAll(selector)).filter(visible); } catch {}
  }
  return Array.from(document.querySelectorAll(
    'button, a[href], input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])'
  )).filter(visible);
}

function findControl({ target, selector, index = 0 } = {}) {
  const pool = candidates(selector);
  if (!target) return pool[Number(index) || 0] || null;
  const q = normalize(target);
  const exact = pool.filter((el) => normalize(labelOf(el)) === q);
  if (exact.length) return exact[Number(index) || 0] || exact[0];
  const starts = pool.filter((el) => normalize(labelOf(el)).startsWith(q));
  if (starts.length) return starts[Number(index) || 0] || starts[0];
  const contains = pool.filter((el) => normalize(labelOf(el)).includes(q));
  return contains[Number(index) || 0] || contains[0] || null;
}

function isTag(el, tagName) {
  return el?.tagName?.toLowerCase() === tagName;
}

function setNativeValue(el, value) {
  if (!el) return false;
  const proto = isTag(el, 'textarea') ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  if (descriptor?.set) descriptor.set.call(el, String(value ?? ''));
  else el.value = String(value ?? '');
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  el.focus();
  return true;
}

const universalActions = [
  {
    name: 'ui_activate',
    description: 'Activate/click any visible application control by its text, aria-label, title, placeholder or CSS selector. Use this when no more specific action exists.',
    params: { target: 'visible label/text to activate', selector: 'optional CSS selector', index: 'optional zero-based match index' },
    handler: (p) => {
      const el = findControl(p);
      if (!el) throw new Error(`UI control not found: ${p?.target || p?.selector || ''}`);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      el.focus?.();
      el.click();
    },
  },
  {
    name: 'ui_set_value',
    description: 'Set the value of any visible input or textarea by label, placeholder, name or CSS selector.',
    params: { target: 'field label/placeholder/name', value: 'value to enter', selector: 'optional CSS selector', index: 'optional zero-based match index' },
    handler: (p) => {
      const el = findControl(p);
      if (!isTag(el, 'input') && !isTag(el, 'textarea')) throw new Error(`Editable field not found: ${p?.target || ''}`);
      setNativeValue(el, p?.value ?? '');
    },
  },
  {
    name: 'ui_select',
    description: 'Choose an option in any visible select control. Match the select by label/name and the option by visible text or value.',
    params: { target: 'select label/name', value: 'option text or value', selector: 'optional CSS selector', index: 'optional zero-based match index' },
    handler: (p) => {
      const el = findControl(p);
      if (!isTag(el, 'select')) throw new Error(`Select control not found: ${p?.target || ''}`);
      const q = normalize(p?.value);
      const option = Array.from(el.options).find((o) => normalize(o.value) === q || normalize(o.textContent) === q || normalize(o.textContent).includes(q));
      if (!option) throw new Error(`Select option not found: ${p?.value || ''}`);
      el.value = option.value;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
      el.focus();
    },
  },
  {
    name: 'ui_scroll',
    description: 'Scroll the current application page or a matched visible element.',
    params: { direction: 'up|down|top|bottom', amount: 'optional pixels', target: 'optional visible label/text', selector: 'optional CSS selector' },
    handler: (p) => {
      const direction = p?.direction || 'down';
      const el = (p?.target || p?.selector) ? findControl(p) : null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: direction === 'up' ? 'start' : 'center' });
        return;
      }
      if (direction === 'top') return window.scrollTo({ top: 0, behavior: 'smooth' });
      if (direction === 'bottom') return window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      const amount = Math.max(100, Number(p?.amount) || Math.round(window.innerHeight * 0.7));
      window.scrollBy({ top: direction === 'up' ? -amount : amount, behavior: 'smooth' });
    },
  },
  {
    name: 'ui_key',
    description: 'Send a keyboard key to the currently focused control, for example Enter, Escape, ArrowDown or Tab.',
    params: { key: 'keyboard key such as Enter|Escape|Tab|ArrowDown|ArrowUp' },
    handler: (p) => {
      const target = document.activeElement || document.body;
      const key = String(p?.key || 'Enter');
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
      target.dispatchEvent(new window.KeyboardEvent('keyup', { key, bubbles: true }));
    },
  },
  {
    name: 'ui_focus',
    description: 'Focus any visible application control without activating it.',
    params: { target: 'visible label/text', selector: 'optional CSS selector', index: 'optional zero-based match index' },
    handler: (p) => {
      const el = findControl(p);
      if (!el) throw new Error(`UI control not found: ${p?.target || ''}`);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus?.();
    },
  },
];

/** Register a component's voice-controllable semantic actions. */
export function registerActions(scope, actions) {
  registry.set(scope, actions);
}

export function unregisterActions(scope) {
  registry.delete(scope);
}

/** Action list to send to the AI (no handlers, schema only). */
export function getActionsForAI() {
  const result = universalActions.map((action) => ({
    name: action.name,
    description: action.description,
    params: action.params || {},
  }));
  for (const [, actions] of registry) {
    for (const action of actions) {
      result.push({ name: action.name, description: action.description, params: action.params || {} });
    }
  }
  return result;
}

/** Run an action by name. */
export function executeAction(name, params = {}) {
  const universal = universalActions.find((a) => a.name === name);
  if (universal?.handler) {
    try { universal.handler(params); }
    catch (e) { console.error('[VoiceRegistry] Universal action error:', name, e); }
    return true;
  }

  for (const [, actions] of registry) {
    const action = actions.find((a) => a.name === name);
    if (action?.handler) {
      try { action.handler(params); }
      catch (e) { console.error('[VoiceRegistry] Action error:', name, e); }
      return true;
    }
  }
  console.warn('[VoiceRegistry] Action not found:', name);
  return false;
}

/**
 * Runs a validated, ordered action plan (see voiceIntentSchema.validateActionPlan)
 * step by step. If a step whose action is in CRITICAL_ACTIONS is not
 * registered (or its handler reports failure by throwing before this call
 * -- executeAction itself always returns true once a handler is found, see
 * above), execution stops instead of continuing on to the next step, so a
 * broken critical step in a multi-step command never silently lets later
 * steps run against a state the earlier step never reached.
 */
export function executePlan(actions = []) {
  const knownNames = new Set(getActionsForAI().map((a) => a.name));
  const results = [];
  for (const step of actions) {
    const name = step?.action;
    if (!name || !knownNames.has(name)) {
      results.push({ action: name || null, ok: false, reason: 'unregistered_action' });
      if (name && CRITICAL_ACTIONS.has(name)) break;
      continue;
    }
    const ok = executeAction(name, step.params || {});
    results.push({ action: name, ok });
    if (!ok && CRITICAL_ACTIONS.has(name)) break;
  }
  return results;
}
