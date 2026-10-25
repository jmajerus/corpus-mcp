# data

`cc-taxonomy.json` is a snapshot of Concept Clusters' published taxonomy (13 domains,
59 categories, 116 subcategories). It is the controlled vocabulary for Calibre tags
(see PLAN.md, *Categories*). Regenerate it from a concept-clusters checkout with access
to the authoring database:

```bash
npm run authoring:taxonomy:export -- --out ../corpus-mcp/data/cc-taxonomy.json
```

The export fails if any name contains ".", so its names are safe to split into Calibre's
hierarchical tags. Three names contain a comma, which Calibre treats as a tag separator;
corpus-mcp drops the comma when it builds the tag and keeps the slugs for the mapping.
