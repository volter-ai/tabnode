[**@volter/tabnode**](../../../../README.md)

***

[@volter/tabnode](../../../../README.md) / [index](../../../README.md) / [url](../README.md) / fileURLToPath

# Function: fileURLToPath()

> **fileURLToPath**(`url`): `string`

Convert a file:// URL to a file path, as Node's own does on Linux (lib/internal/url.js getPathFromURLPosix): a host
other than empty or localhost (which the URL parser makes empty) is ERR_INVALID_FILE_URL_HOST, and an encoded '/'
in the path is ERR_INVALID_FILE_URL_PATH, never decoded into a separator the URL did not have.
Node.js: url.fileURLToPath('file:///home/user/file.txt') -> '/home/user/file.txt'

## Parameters

### url

`string` \| `URL`

## Returns

`string`
