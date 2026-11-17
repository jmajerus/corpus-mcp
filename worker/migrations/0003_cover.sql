-- Each book's cover thumbnail stamp, or NULL for no cover; the image itself is in R2 (src/public/covers.ts).
ALTER TABLE books ADD COLUMN cover TEXT;
