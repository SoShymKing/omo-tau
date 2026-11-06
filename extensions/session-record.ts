const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// OMO decorates persisted records with runtime metadata at these exact paths.
export function comparisonRecord(entry: unknown): unknown {
  if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message)) return entry;
  const message = entry.message;
  switch (message.role) {
    case "assistant":
      if (!Array.isArray(message.content)) return entry;
      return { ...entry, message: { ...message, content: message.content.map(part =>
        isObject(part) ? Object.fromEntries(Object.entries(part).filter(([key]) => key !== "runtimeItemKey")) : part),
      } };
    case "toolResult":
      return Object.fromEntries(Object.entries(entry).filter(([key, value]) =>
        key !== "runtimeItemKey" && !(key === "callUnknown" && value === true)));
    default:
      return entry;
  }
}
