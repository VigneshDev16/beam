#import "BeamReceiver.h"
#import <UIKit/UIKit.h>
#import <GCDWebServer/GCDWebServer.h>
#import <GCDWebServer/GCDWebServerDataResponse.h>
#import <GCDWebServer/GCDWebServerMultiPartFormRequest.h>

static const NSUInteger kBeamPort = 8791;

@implementation BeamReceiver {
  GCDWebServer *_server;
  BOOL _hasListeners;
}

RCT_EXPORT_MODULE(BeamReceiver);

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// GCDWebServer's debug-build assertions require first use on the main thread.
- (dispatch_queue_t)methodQueue {
  return dispatch_get_main_queue();
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"beamReceived" ];
}

- (void)startObserving {
  _hasListeners = YES;
}

- (void)stopObserving {
  _hasListeners = NO;
}

- (NSString *)deviceName {
  return UIDevice.currentDevice.name ?: @"iPhone";
}

- (NSString *)uniqueDestinationFor:(NSString *)filename inDir:(NSString *)dir {
  NSString *base = [filename stringByDeletingPathExtension];
  NSString *ext = [filename pathExtension];
  NSString *candidate = [dir stringByAppendingPathComponent:filename];
  NSUInteger i = 1;
  NSFileManager *fm = NSFileManager.defaultManager;
  while ([fm fileExistsAtPath:candidate]) {
    NSString *renamed = ext.length
        ? [NSString stringWithFormat:@"%@ (%lu).%@", base, (unsigned long)i, ext]
        : [NSString stringWithFormat:@"%@ (%lu)", base, (unsigned long)i];
    candidate = [dir stringByAppendingPathComponent:renamed];
    i++;
  }
  return candidate;
}

RCT_EXPORT_METHOD(start:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  if (_server && _server.isRunning) {
    resolve(@{ @"port" : @(kBeamPort), @"name" : [self deviceName] });
    return;
  }

  _server = [[GCDWebServer alloc] init];
  __weak BeamReceiver *weakSelf = self;

  [_server addHandlerForMethod:@"GET"
                          path:@"/info"
                  requestClass:[GCDWebServerRequest class]
                  processBlock:^GCDWebServerResponse *(GCDWebServerRequest *request) {
    BeamReceiver *self = weakSelf;
    NSDictionary *info = @{
      @"app" : @"beam",
      @"name" : self ? [self deviceName] : @"iPhone",
      @"platform" : @"ios",
      @"version" : @"0.1.0",
    };
    return [GCDWebServerDataResponse responseWithJSONObject:info];
  }];

  [_server addHandlerForMethod:@"POST"
                          path:@"/upload"
                  requestClass:[GCDWebServerMultiPartFormRequest class]
                  processBlock:^GCDWebServerResponse *(GCDWebServerRequest *request) {
    BeamReceiver *self = weakSelf;
    GCDWebServerMultiPartFormRequest *upload = (GCDWebServerMultiPartFormRequest *)request;
    NSString *sender = request.query[@"from"] ?: @"Device";
    NSString *docs = NSSearchPathForDirectoriesInDomains(
        NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    NSMutableArray *saved = [NSMutableArray array];

    for (GCDWebServerMultiPartFile *file in upload.files) {
      NSString *name = file.fileName.lastPathComponent ?: @"unnamed";
      NSString *dest = self ? [self uniqueDestinationFor:name inDir:docs]
                            : [docs stringByAppendingPathComponent:name];
      NSError *err = nil;
      [NSFileManager.defaultManager moveItemAtPath:file.temporaryPath
                                            toPath:dest
                                             error:&err];
      if (!err) {
        [saved addObject:dest.lastPathComponent];
        if (self && self->_hasListeners) {
          [self sendEventWithName:@"beamReceived"
                             body:@{
                               @"name" : dest.lastPathComponent,
                               @"uri" : dest,
                               @"sender" : sender,
                             }];
        }
      }
    }
    return [GCDWebServerDataResponse
        responseWithJSONObject:@{ @"ok" : @YES, @"saved" : saved }];
  }];

  NSError *error = nil;
  BOOL ok = [_server startWithOptions:@{
    GCDWebServerOption_Port : @(kBeamPort),
    GCDWebServerOption_BindToLocalhost : @NO,
    GCDWebServerOption_AutomaticallySuspendInBackground : @YES,
  } error:&error];

  if (ok) {
    resolve(@{ @"port" : @(kBeamPort), @"name" : [self deviceName] });
  } else {
    reject(@"beam_start_failed", error.localizedDescription ?: @"failed", error);
  }
}

RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject) {
  if (_server.isRunning) {
    [_server stop];
  }
  _server = nil;
  resolve(nil);
}

@end
