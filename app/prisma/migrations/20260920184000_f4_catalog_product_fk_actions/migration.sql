-- Correct the delete actions for databases that already applied the initial
-- membership migration: deleting a release removes only its memberships,
-- while an immutable product version cannot be deleted while still referenced.
ALTER TABLE "funding_catalog_products"
DROP CONSTRAINT "funding_catalog_products_catalogReleaseId_fkey";

ALTER TABLE "funding_catalog_products"
DROP CONSTRAINT "funding_catalog_products_productVersionId_fkey";

ALTER TABLE "funding_catalog_products"
ADD CONSTRAINT "funding_catalog_products_catalogReleaseId_fkey"
FOREIGN KEY ("catalogReleaseId") REFERENCES "funding_catalog_releases"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "funding_catalog_products"
ADD CONSTRAINT "funding_catalog_products_productVersionId_fkey"
FOREIGN KEY ("productVersionId") REFERENCES "funding_product_versions"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
