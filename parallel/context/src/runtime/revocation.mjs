export class RevocationSet {
  constructor({ ids = [], texts = [] } = {}) {
    this.ids = new Set(ids);
    this.texts = new Set(texts.filter((text) => typeof text === "string" && text.length >= 8));
  }

  static fromJSON(value) {
    return new RevocationSet(value ?? {});
  }

  hasId(id) {
    if (!id) return false;
    if (this.ids.has(id)) return true;
    for (const revoked of this.ids) {
      if (id.startsWith(`${revoked}:`) || id.startsWith(`${revoked}/`)) return true;
    }
    return false;
  }

  hasPrefix(id) {
    return this.hasId(id);
  }

  containsText(text) {
    if (typeof text !== "string") return false;
    for (const revoked of this.texts) {
      if (text.includes(revoked)) return true;
    }
    return false;
  }

  revoke(ids = [], texts = []) {
    let changed = false;
    for (const id of ids) {
      if (typeof id === "string" && id && !this.ids.has(id)) {
        this.ids.add(id);
        changed = true;
      }
    }
    for (const text of texts) {
      if (typeof text === "string" && text.length >= 8 && !this.texts.has(text)) {
        this.texts.add(text);
        changed = true;
      }
    }
    return changed;
  }

  toJSON() {
    return { ids: [...this.ids].sort(), texts: [...this.texts].sort() };
  }
}
