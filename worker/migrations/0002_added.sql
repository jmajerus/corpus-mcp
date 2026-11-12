-- When each book was added to Calibre, for the Books page's "Added" order (src/public/snapshot.ts SNAPSHOT_SCHEMA).
ALTER TABLE books ADD COLUMN added TEXT;
