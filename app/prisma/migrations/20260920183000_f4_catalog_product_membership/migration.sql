-- Product versions are immutable and can be reused by more than one catalog
-- release. Move release membership out of the version row into a join table.
CREATE TABLE "funding_catalog_products" (
    "catalogReleaseId" TEXT NOT NULL,
    "productVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "funding_catalog_products_pkey" PRIMARY KEY ("catalogReleaseId", "productVersionId")
);

INSERT INTO "funding_catalog_products" ("catalogReleaseId", "productVersionId", "position")
SELECT
    "catalogReleaseId",
    "id",
    (ROW_NUMBER() OVER (PARTITION BY "catalogReleaseId" ORDER BY "createdAt", "id") - 1)::INTEGER
FROM "funding_product_versions";

ALTER TABLE "funding_product_versions"
DROP CONSTRAINT "funding_product_versions_catalogReleaseId_fkey";

ALTER TABLE "funding_product_versions"
DROP COLUMN "catalogReleaseId";

CREATE UNIQUE INDEX "funding_catalog_products_catalogReleaseId_position_key"
ON "funding_catalog_products"("catalogReleaseId", "position");

CREATE INDEX "funding_catalog_products_productVersionId_idx"
ON "funding_catalog_products"("productVersionId");

ALTER TABLE "funding_catalog_products"
ADD CONSTRAINT "funding_catalog_products_catalogReleaseId_fkey"
FOREIGN KEY ("catalogReleaseId") REFERENCES "funding_catalog_releases"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "funding_catalog_products"
ADD CONSTRAINT "funding_catalog_products_productVersionId_fkey"
FOREIGN KEY ("productVersionId") REFERENCES "funding_product_versions"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
