-- A pair may await its first comparison before either original has yielded
-- all of the title-block metadata. The lead publishes these two proof forms.
ALTER TABLE harness_package_review_pairs
  ALTER COLUMN proof DROP NOT NULL,
  ALTER COLUMN wire_proof DROP NOT NULL;
