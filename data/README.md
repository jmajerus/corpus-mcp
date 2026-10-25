# data

`cc-taxonomy.json` is a snapshot of Concept Clusters' published taxonomy (13 domains,
59 categories, 116 subcategories). It is the controlled vocabulary for Calibre tags
(see PLAN.md, *Categories*). Regenerate it from a concept-clusters checkout with access
to the authoring database:

```bash
npm run authoring:taxonomy:export -- --out ../corpus-mcp/data/cc-taxonomy.json
```

Calibre tags are built from the slugs (`social-sciences.psychology.social-psychology`), which
are Concept Clusters' stable ids: a renamed category leaves Calibre's tags valid, and slugs hold no
commas (Calibre's tag separator) or dots (its hierarchy marker). Titles are kept as labels for
display, and every lookup accepts either form. The export warns about names containing a comma
and fails on names containing ".".
