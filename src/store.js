import { demoState } from './demo-data.js';

const STORAGE_KEY = 'budgeto-demo-state-v1';

const clone = (value) => JSON.parse(JSON.stringify(value));

export function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { ...clone(demoState), ...JSON.parse(stored) } : clone(demoState);
  } catch {
    return clone(demoState);
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetState() {
  const state = clone(demoState);
  saveState(state);
  return state;
}
