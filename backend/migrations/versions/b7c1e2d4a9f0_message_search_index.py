"""trigram index for server-wide message search

Search uses case-insensitive substring matching (ILIKE '%term%'). A pg_trgm GIN
index lets PostgreSQL answer that without scanning every message. Creating the
extension needs sufficient privileges; if they're missing the index is skipped
and search still works, just without the index.
"""

import logging

from alembic import op

revision = "b7c1e2d4a9f0"
down_revision = "82af1b636edc"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    nested = bind.begin_nested()
    try:
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_messages_body_trgm "
            "ON messages USING gin (body gin_trgm_ops)"
        )
        nested.commit()
    except Exception as exc:  # pragma: no cover - depends on hosting privileges
        nested.rollback()
        log.warning("Skipping message search index (pg_trgm unavailable): %s", exc)


def downgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_messages_body_trgm")
