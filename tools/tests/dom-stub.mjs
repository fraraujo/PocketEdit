// Minimal DOM + browser stubs so the application code can be exercised in Node.
// Only what the editor actually touches is implemented.
class StubElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
    this._classes = new Set();
    this._attrs = new Map();
    this.dataset = {};
    this.style = {};
    this.options = [];
    this.value = '';
    this.textContent = '';
    this._html = '';
    this.disabled = false;
    this.draggable = false;
    this.id = '';
    this.title = '';
    this.isConnected = true;
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      contains: (c) => this._classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this._classes.has(c) : Boolean(force);
        if (on) this._classes.add(c); else this._classes.delete(c);
        return on;
      },
    };
  }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  hasAttribute(k) { return this._attrs.has(k) || k in this; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); this.childNodes.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : this.children.length; this.children.splice(i, 0, c); this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); const j = this.childNodes.indexOf(c); if (j >= 0) this.childNodes.splice(j, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); this.isConnected = false; }
  replaceWith() {}
  focus() {}
  select() {}
  click() { this.dispatchEvent({ type: 'click', target: this }); }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, width: 0 }; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.childNodes[0]; }
  get nextElementSibling() { return null; }
  get previousElementSibling() { return null; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; this.children.length = 0; this.childNodes.length = 0; }
}

export function createDocument() {
  const ids = new Map();
  return {
    ids,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id) => {
      if (!ids.has(id)) { const el = new StubElement(); el.id = id; ids.set(id, el); }
      return ids.get(id);
    },
    createElement: (tag) => new StubElement(tag),
    createDocumentFragment: () => new StubElement('fragment'),
    createTextNode: (text) => { const el = new StubElement('#text'); el.textContent = text; return el; },
    get body() { return this.getElementById('#body'); },
    activeElement: { tagName: 'BODY' },
    readyState: 'complete',
  };
}

export { StubElement };
