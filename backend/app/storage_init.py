"""Create the private attachment bucket if it does not exist (local development)."""

import time
from botocore.exceptions import ClientError, EndpointConnectionError
from .attachments import s3
from .config import settings


def storage_init(attempts=30):
    client = s3()
    for attempt in range(attempts):
        try:
            client.head_bucket(Bucket=settings.s3_bucket)
            break
        except EndpointConnectionError:
            if attempt == attempts - 1:
                raise
            time.sleep(2)
        except ClientError as e:
            if e.response["Error"]["Code"] not in ("404", "NoSuchBucket"):
                raise
            client.create_bucket(Bucket=settings.s3_bucket)
            break
    print(f"Storage ready: bucket {settings.s3_bucket}")


if __name__ == "__main__":
    storage_init()
