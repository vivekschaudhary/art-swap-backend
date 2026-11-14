export type ReadinessFacts = {
  hasCategory: boolean;
  hasTitle: boolean;
  hasCondition: boolean;
  readyMediaCount: number;
  attributes: Record<string, unknown>;
  requiredAttributes: string[];
};

/**
 * publish_readiness (§5.3). Canonical missing names: category, title, condition, media,
 * and attributes.<name> for each missing required attribute. Only computed when a category is set.
 */
export function publishReadiness(f: ReadinessFacts): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!f.hasCategory) missing.push("category");
  if (!f.hasTitle) missing.push("title");
  if (!f.hasCondition) missing.push("condition");
  if (f.readyMediaCount === 0) missing.push("media");
  if (f.hasCategory) {
    for (const name of f.requiredAttributes) {
      if (f.attributes[name] === undefined || f.attributes[name] === null) missing.push(`attributes.${name}`);
    }
  }
  return { ready: missing.length === 0, missing };
}
