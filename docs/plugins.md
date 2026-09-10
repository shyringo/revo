# Local Plugins

Plugins are explicit trusted ES modules listed in the private configuration. Revo never auto-discovers or downloads executable code.

Paths are resolved relative to the configuration file directory:

```json
{
  "plugins": ["plugins/environment-note.mjs"]
}
```

A plugin exports a named object with `mount(kernel)`. This example adds one read-only parallel tool and observes durable deliveries:

```js
export default {
  name: "environment-note",
  mount(kernel) {
    const tools = kernel.service("tools");
    const events = kernel.service("events");

    const unregister = tools.register({
      name: "environment_note",
      description: "Return one configured environment note.",
      executionMode: "parallel",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      async execute() {
        return { note: "Example local observation" };
      }
    });

    const unsubscribe = events.subscribe((event) => {
      if (event.type === "delivery.created") {
        // Feed a local notifier or projection. Do not throw secrets into logs.
      }
    });

    return () => {
      unsubscribe();
      unregister();
    };
  }
};
```

Plugin disposers run in reverse mount order during sleep. A plugin can reach credentials, files, tools, and process APIs available to Revo; review it as application code, not as prompt text. Plugin events and side effects should follow the same intent/effect and human-approval standards as built-in capabilities.
