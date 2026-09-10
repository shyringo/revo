import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadPlugins(kernel, paths, baseDir = process.cwd()) {
  for (const configuredPath of paths || []) {
    const path = resolve(baseDir, configuredPath);
    const module = await import(pathToFileURL(path).href);
    const exported = module.default ?? module.plugin;
    const plugin = typeof exported === "function" && !exported.mount
      ? await exported(kernel)
      : exported;
    if (!plugin?.name || typeof plugin.mount !== "function") {
      throw new Error(`Invalid Revo plugin ${path}: export a named plugin with mount(kernel)`);
    }
    await kernel.use(plugin);
  }
}
