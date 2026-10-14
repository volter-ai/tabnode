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
- [FetchActivity](interfaces/FetchActivity.md)
- [FetchTransportContext](interfaces/FetchTransportContext.md)
- [FSNode](interfaces/FSNode.md)
- [FSWatcher](interfaces/FSWatcher.md)
- [HttpClientExchangeRequest](interfaces/HttpClientExchangeRequest.md)
- [HttpClientExchangeResponse](interfaces/HttpClientExchangeResponse.md)
- [HttpClientTransportOptions](interfaces/HttpClientTransportOptions.md)
- [IExecuteResult](interfaces/IExecuteResult.md)
- [InitialProcessRegistration](interfaces/InitialProcessRegistration.md)
- [InitServiceWorkerOptions](interfaces/InitServiceWorkerOptions.md)
- [IRuntime](interfaces/IRuntime.md)
- [IRuntimeOptions](interfaces/IRuntimeOptions.md)
- [LoopbackStreamFlow](interfaces/LoopbackStreamFlow.md)
- [Module](interfaces/Module.md)
- [ModuleEvaluationEvidence](interfaces/ModuleEvaluationEvidence.md)
- [ModuleEvaluationObserver](interfaces/ModuleEvaluationObserver.md)
- [MountedTree](interfaces/MountedTree.md)
- [NativeStreamDescriptor](interfaces/NativeStreamDescriptor.md)
- [NativeStreamHandleView](interfaces/NativeStreamHandleView.md)
- [NativeStreamLimits](interfaces/NativeStreamLimits.md)
- [NativeStreamReply](interfaces/NativeStreamReply.md)
- [NativeStreamTransport](interfaces/NativeStreamTransport.md)
- [NativeStreamWriteTrace](interfaces/NativeStreamWriteTrace.md)
- [NodeProcessHost](interfaces/NodeProcessHost.md)
- [NodeProcessLaunch](interfaces/NodeProcessLaunch.md)
- [NodeResolver](interfaces/NodeResolver.md)
- [NodeResolverOptions](interfaces/NodeResolverOptions.md)
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
- [Stats](interfaces/Stats.md)
- [StdinReader](interfaces/StdinReader.md)
- [TreeAdvisoryLocks](interfaces/TreeAdvisoryLocks.md)
- [TreeDescriptors](interfaces/TreeDescriptors.md)
- [TreeDescriptorStats](interfaces/TreeDescriptorStats.md)
- [TreeRecordLock](interfaces/TreeRecordLock.md)
- [VFSSnapshot](interfaces/VFSSnapshot.md)

## Type Aliases

- [FetchTransport](type-aliases/FetchTransport.md)
- [FsShim](type-aliases/FsShim.md)
- [HttpClientExchange](type-aliases/HttpClientExchange.md)
- [HttpClientTransportFactory](type-aliases/HttpClientTransportFactory.md)
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
- [installFetchTransport](functions/installFetchTransport.md)
- [installHostNames](functions/installHostNames.md)
- [installHttpClientTransport](functions/installHttpClientTransport.md)
- [installNativeStreamTransport](functions/installNativeStreamTransport.md)
- [installNodeProcessHost](functions/installNodeProcessHost.md)
- [installProcessIdAllocator](functions/installProcessIdAllocator.md)
- [installProcessRegistry](functions/installProcessRegistry.md)
- [isPreparedModuleKey](functions/isPreparedModuleKey.md)
- [nativeStreamDescriptor](functions/nativeStreamDescriptor.md)
- [nodeProcessHostInstalled](functions/nodeProcessHostInstalled.md)
- [preparedModuleKey](functions/preparedModuleKey.md)
- [preparedModuleKeyOf](functions/preparedModuleKeyOf.md)
- [preparedModuleKind](functions/preparedModuleKind.md)
- [prepareHttpParserModule](functions/prepareHttpParserModule.md)
- [prepareModuleForImage](functions/prepareModuleForImage.md)
- [processByPid](functions/processByPid.md)
- [processCredentialsOf](functions/processCredentialsOf.md)
- [requestHasStaticBody](functions/requestHasStaticBody.md)
- [resetServerBridge](functions/resetServerBridge.md)
- [restoreHostGlobals](functions/restoreHostGlobals.md)
- [runPid](functions/runPid.md)
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
