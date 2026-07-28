from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.core.config import settings

engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def init_db():
    from sqlalchemy import inspect, text
    Base.metadata.create_all(bind=engine)
    
    # Auto-migration helper for SQLite columns
    with engine.connect() as conn:
        inspector = inspect(engine)
        if "podcasts" in inspector.get_table_names():
            columns = [c["name"] for c in inspector.get_columns("podcasts")]
            if "characters" not in columns:
                conn.execute(text("ALTER TABLE podcasts ADD COLUMN characters TEXT"))
                conn.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
