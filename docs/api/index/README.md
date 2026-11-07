[**@volter/tabnode**](../README.md)

***

[@volter/tabnode](../README.md) / index

# index

## Namespaces

- [esbuild](namespaces/esbuild/README.md)
- [module](namespaces/module/README.md)
- [npm](namespaces/npm/README.md)
- [path](namespaces/path/README.md)
- [perf\_hooks](namespaces/perf_hooks/README.md)
- [rollup](namespaces/rollup/README.md)
- [url](namespaces/url/README.md)
- [worker\_threads](namespaces/worker_threads/README.md)

## Classes

- [NativeStreamScope](classes/NativeStreamScope.md)
- [PortBridge](classes/PortBridge.md)
- [Runtime](classes/Runtime.md)
- [ServerBridge](classes/ServerBridge.md)
- [StdinRingWriter](classes/StdinRingWriter.md)
- [VirtualFS](classes/VirtualFS.md)
- [WorkerRuntime](classes/WorkerRuntime.md)

## Interfaces

- [ContainerOptions](interfaces/ContainerOptions.md)
- [CreateRuntimeOptions](interfaces/CreateRuntimeOptions.md)
- [ExportsResolver](interfaces/ExportsResolver.md)
- [FSNode](interfaces/FSNode.md)
- [FSWatcher](interfaces/FSWatcher.md)
- [IExecuteResult](interfaces/IExecuteResult.md)
- [InitialProcessRegistration](interfaces/InitialProcessRegistration.md)
- [InitServiceWorkerOptions](interfaces/InitServiceWorkerOptions.md)
- [InterfaceAddressEntry](interfaces/InterfaceAddressEntry.md)
- [IRuntime](interfaces/IRuntime.md)
- [IRuntimeOptions](interfaces/IRuntimeOptions.md)
- [LoopbackStreamFlow](interfaces/LoopbackStreamFlow.md)
- [Module](interfaces/Module.md)
- [ModuleEvaluationEvidence](interfaces/ModuleEvaluationEvidence.md)
- [ModuleEvaluationObserver](interfaces/ModuleEvaluationObserver.md)
- [MountedTree](interfaces/MountedTree.md)
- [NativeLoaded](interfaces/NativeLoaded.md)
- [NativeLoadRequest](interfaces/NativeLoadRequest.md)
- [NativeStreamDescriptor](interfaces/NativeStreamDescriptor.md)
- [NativeStreamHandleView](interfaces/NativeStreamHandleView.md)
- [NativeStreamLimits](interfaces/NativeStreamLimits.md)
- [NativeStreamReply](interfaces/NativeStreamReply.md)
- [NativeStreamTransport](interfaces/NativeStreamTransport.md)
- [NodeProcessHost](interfaces/NodeProcessHost.md)
- [NodeProcessLaunch](interfaces/NodeProcessLaunch.md)
- [NodeResolver](interfaces/NodeResolver.md)
- [NodeResolverOptions](interfaces/NodeResolverOptions.md)
- [PollDescriptor](interfaces/PollDescriptor.md)
- [Process](interfaces/Process.md)
- [ProcessCredentials](interfaces/ProcessCredentials.md)
- [ProcessEnv](interfaces/ProcessEnv.md)
- [ProcessIdentity](interfaces/ProcessIdentity.md)
- [ProcessRegistry](interfaces/ProcessRegistry.md)
- [ProcessRegistryScope](interfaces/ProcessRegistryScope.md)
- [RequireFunction](interfaces/RequireFunction.md)
- [ResolutionFs](interfaces/ResolutionFs.md)
- [ResponseData](interfaces/ResponseData.md)
- [RunOptions](interfaces/RunOptions.md)
- [RunResult](interfaces/RunResult.md)
- [RuntimeOptions](interfaces/RuntimeOptions.md)
- [SocketMessage](interfaces/SocketMessage.md)
- [Stats](interfaces/Stats.md)
- [StdinReader](interfaces/StdinReader.md)
- [TlsClientOptions](interfaces/TlsClientOptions.md)
- [TlsClientSession](interfaces/TlsClientSession.md)
- [TlsPeerCertificate](interfaces/TlsPeerCertificate.md)
- [TlsPlainConnection](interfaces/TlsPlainConnection.md)
- [TlsSecureConnection](interfaces/TlsSecureConnection.md)
- [TlsServerOptions](interfaces/TlsServerOptions.md)
- [TlsServerSecureConnection](interfaces/TlsServerSecureConnection.md)
- [TlsServerSession](interfaces/TlsServerSession.md)
- [TlsTransport](interfaces/TlsTransport.md)
- [TreeAdvisoryLocks](interfaces/TreeAdvisoryLocks.md)
- [TreeDescriptors](interfaces/TreeDescriptors.md)
- [TreeDescriptorStats](interfaces/TreeDescriptorStats.md)
- [TreeNative](interfaces/TreeNative.md)
- [TreeRecordLock](interfaces/TreeRecordLock.md)
- [TreeSockets](interfaces/TreeSockets.md)
- [TreeTls](interfaces/TreeTls.md)
- [VFSSnapshot](interfaces/VFSSnapshot.md)

## Type Aliases

- [FsShim](type-aliases/FsShim.md)
- [NativeStreamEvent](type-aliases/NativeStreamEvent.md)
- [NativeStreamOperation](type-aliases/NativeStreamOperation.md)
- [StdioKind](type-aliases/StdioKind.md)
- [WatchEventType](type-aliases/WatchEventType.md)
- [WatchListener](type-aliases/WatchListener.md)

## Variables

- [buffer](variables/buffer.md)
- [events](variables/events.md)
- [http](variables/http.md)
- [https](variables/https.md)
- [NATIVE\_THREAD\_MODULE](variables/NATIVE_THREAD_MODULE.md)
- [net](variables/net.md)
- [PREPARED\_MODULES\_DIR](variables/PREPARED_MODULES_DIR.md)
- [PREPARED\_MODULES\_FORMAT](variables/PREPARED_MODULES_FORMAT.md)
- [PREPARED\_MODULES\_KEPT](variables/PREPARED_MODULES_KEPT.md)
- [RUN\_LINE\_FILESYSTEM](variables/RUN_LINE_FILESYSTEM.md)
- [RUN\_SIGNAL\_DISPOSITIONS](variables/RUN_SIGNAL_DISPOSITIONS.md)
- [RUN\_STDIN\_READER](variables/RUN_STDIN_READER.md)
- [STDIN\_RING](variables/STDIN_RING.md)
- [stream](variables/stream.md)
- [TREE\_DESCRIPTORS](variables/TREE_DESCRIPTORS.md)
- [TREE\_NATIVE](variables/TREE_NATIVE.md)
- [TREE\_SOCKETS](variables/TREE_SOCKETS.md)
- [TREE\_TLS](variables/TREE_TLS.md)
- [util](variables/util.md)

## Functions

- [createContainer](functions/createContainer.md)
- [createFsShim](functions/createFsShim.md)
- [createNodeResolver](functions/createNodeResolver.md)
- [createProcess](functions/createProcess.md)
- [createRuntime](functions/createRuntime.md)
- [createStdinRing](functions/createStdinRing.md)
- [execute](functions/execute.md)
- [getPortBridge](functions/getPortBridge.md)
- [getServerBridge](functions/getServerBridge.md)
- [guestRealmInstalled](functions/guestRealmInstalled.md)
- [installNativeStreamTransport](functions/installNativeStreamTransport.md)
- [installNodeProcessHost](functions/installNodeProcessHost.md)
- [installProcessIdAllocator](functions/installProcessIdAllocator.md)
- [installProcessRegistry](functions/installProcessRegistry.md)
- [isPreparedModuleKey](functions/isPreparedModuleKey.md)
- [keptResolutions](functions/keptResolutions.md)
- [nativeStreamDescriptor](functions/nativeStreamDescriptor.md)
- [nodeProcessHostInstalled](functions/nodeProcessHostInstalled.md)
- [precompileNodeLib](functions/precompileNodeLib.md)
- [preparedModuleKey](functions/preparedModuleKey.md)
- [preparedModuleKeyOf](functions/preparedModuleKeyOf.md)
- [preparedModuleKind](functions/preparedModuleKind.md)
- [prepareHttpParserModule](functions/prepareHttpParserModule.md)
- [prepareModuleForImage](functions/prepareModuleForImage.md)
- [processByPid](functions/processByPid.md)
- [processCredentialsOf](functions/processCredentialsOf.md)
- [resetServerBridge](functions/resetServerBridge.md)
- [restoreHostGlobals](functions/restoreHostGlobals.md)
- [runPid](functions/runPid.md)
- [seedKeptResolutions](functions/seedKeptResolutions.md)
- [stdinRingProblem](functions/stdinRingProblem.md)

## References

### default

Renames and re-exports [createContainer](functions/createContainer.md)

***

### install

Re-exports [install](namespaces/npm/functions/install.md)

***

### PackageManager

Re-exports [PackageManager](namespaces/npm/classes/PackageManager.md)
