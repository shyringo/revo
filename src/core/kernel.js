import { EventEmitter } from "node:events";

export class Kernel extends EventEmitter {
  #plugins = new Map();
  #services = new Map();
  #disposers = [];

  provide(name, service) {
    if (this.#services.has(name)) throw new Error(`Service already exists: ${name}`);
    this.#services.set(name, service);
    this.emit("service:provided", { name });
    return () => this.#services.delete(name);
  }

  service(name) {
    const service = this.#services.get(name);
    if (!service) throw new Error(`Service not found: ${name}`);
    return service;
  }

  has(name) {
    return this.#services.has(name);
  }

  async use(plugin) {
    if (!plugin?.name || typeof plugin.mount !== "function") {
      throw new TypeError("A plugin needs a name and mount(kernel) function");
    }
    if (this.#plugins.has(plugin.name)) throw new Error(`Plugin already mounted: ${plugin.name}`);
    const dispose = await plugin.mount(this);
    this.#plugins.set(plugin.name, plugin);
    if (dispose) this.#disposers.push({ name: plugin.name, dispose });
    this.emit("plugin:mounted", { name: plugin.name });
  }

  plugins() {
    return [...this.#plugins.keys()];
  }

  async close() {
    for (const entry of this.#disposers.reverse()) await entry.dispose();
    this.#disposers = [];
    this.#plugins.clear();
    this.#services.clear();
  }
}
