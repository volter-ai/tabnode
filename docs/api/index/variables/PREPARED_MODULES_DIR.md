[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / PREPARED\_MODULES\_DIR

# Variable: PREPARED\_MODULES\_DIR

> `const` **PREPARED\_MODULES\_DIR**: `"/.tabnode/prepared"` = `'/.tabnode/prepared'`

Module bodies prepared where the image is built. Parsing a package's files
for the passes above is most of a `require` in a tab: 36 of 45 s for
playwright-core's, measured in a tab, against 0.9 s under Node on the same
machine. The image carries each body under the hash of the file it was made
from, in this directory of the tab's filesystem, and the loader takes it in
place of the passes when the file it read hashes to one. A body the loader
prepares for a file the image has none for is kept there the same way.
