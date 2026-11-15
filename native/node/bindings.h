// What the bindings' C shares (Tabnode ADR-0018 §3), as Node's src/node.h and its util declare it.
#ifndef TABNODE_BINDINGS_H
#define TABNODE_BINDINGS_H

// Node's signo_string (src/node.h:1307, src/api/utils.cc): a signal's name, "" for a number that names none.
const char *signo_string(int signo);
#endif
