-- Blog taxonomy: categories (one-level hierarchy) + free-form tags, with
-- many-to-many junctions to posts. Slugs are validated in the app layer
-- (lib/cms/page-slug rules + a taxonomy reserved set) before insert; the
-- UNIQUE(slug) here is the last-line guard. Junctions cascade on either
-- side so deleting a post or a term never leaves an orphan row.
CREATE TABLE IF NOT EXISTS categories (
  id           INT NOT NULL AUTO_INCREMENT,
  slug         VARCHAR(120) NOT NULL,
  name         VARCHAR(120) NOT NULL,
  description  VARCHAR(320) NULL,
  parent_id    INT NULL,
  position     INT NOT NULL DEFAULT 0,
  version      INT NOT NULL DEFAULT 0,
  updated_by   INT NULL,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY idx_categories_slug (slug),
  KEY idx_categories_parent (parent_id),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT fk_categories_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id          INT NOT NULL AUTO_INCREMENT,
  slug        VARCHAR(120) NOT NULL,
  name        VARCHAR(120) NOT NULL,
  updated_by  INT NULL,
  updated_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY idx_tags_slug (slug),
  CONSTRAINT fk_tags_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS post_categories (
  post_id      INT NOT NULL,
  category_id  INT NOT NULL,
  PRIMARY KEY (post_id, category_id),
  KEY idx_pc_category (category_id, post_id),
  CONSTRAINT fk_pc_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_pc_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id  INT NOT NULL,
  tag_id   INT NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  KEY idx_pt_tag (tag_id, post_id),
  CONSTRAINT fk_pt_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_pt_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
