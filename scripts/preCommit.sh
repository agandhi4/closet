#!/bin/sh
# Clean-room run of the full pre-PR gate (see `precommit:full` in package.json).
rm -rf data \
&& npm ci \
&& npm run precommit:full
