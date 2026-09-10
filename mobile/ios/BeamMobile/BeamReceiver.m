#import "BeamReceiver.h"
#import <UIKit/UIKit.h>
#import <GCDWebServer/GCDWebServer.h>
#import <GCDWebServer/GCDWebServerDataRequest.h>
#import <GCDWebServer/GCDWebServerDataResponse.h>
#import <GCDWebServer/GCDWebServerMultiPartFormRequest.h>

static const NSUInteger kBeamPort = 8791;
static const NSTimeInterval kOfferTTL = 120;
static NSString *const kDeviceIdKey = @"BeamDeviceId";
static NSString *const kTrustedKey = @"BeamTrustedDevices";

/** GCDWebServer has no responseWithJSONObject:statusCode:, so set it after. */
static GCDWebServerDataResponse *BeamJSON(id object, NSInteger statusCode) {
  GCDWebServerDataResponse *response =
      [GCDWebServerDataResponse responseWithJSONObject:object];
  response.statusCode = statusCode;
  return response;
}

/** A pending or approved transfer request. */
@interface BeamOffer : NSObject
@property(nonatomic, copy) NSString *offerId;
@property(nonatomic, copy) NSString *from;
@property(nonatomic, copy) NSString *deviceId;
@property(nonatomic, copy) NSString *code;
@property(nonatomic, copy) NSString *status;   // pending|accepted|declined|used
@property(nonatomic, copy) NSString *token;
@property(nonatomic, assign) NSInteger usesLeft;
@property(nonatomic, assign) NSInteger fileCount;
@property(nonatomic, strong) NSDate *createdAt;
/** Set for legacy uploads that are waiting on the user before being saved. */
@property(nonatomic, copy) void (^pendingSave)(BOOL accepted);
@end

@implementation BeamOffer
@end

@implementation BeamReceiver {
  GCDWebServer *_server;
  BOOL _hasListeners;
  NSMutableDictionary<NSString *, BeamOffer *> *_offers;
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
  return @[ @"beamReceived", @"beamApprovalRequest" ];
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

#pragma mark - identity and trust

- (NSString *)ownDeviceId {
  NSUserDefaults *d = NSUserDefaults.standardUserDefaults;
  NSString *existing = [d stringForKey:kDeviceIdKey];
  if (existing.length) return existing;
  NSString *fresh = NSUUID.UUID.UUIDString;
  [d setObject:fresh forKey:kDeviceIdKey];
  return fresh;
}

- (NSArray<NSString *> *)trustedIds {
  return [NSUserDefaults.standardUserDefaults arrayForKey:kTrustedKey] ?: @[];
}

- (BOOL)isTrusted:(NSString *)deviceId {
  return deviceId.length > 0 && [[self trustedIds] containsObject:deviceId];
}

- (void)trustDevice:(NSString *)deviceId {
  if (!deviceId.length) return;
  NSMutableArray *list = [[self trustedIds] mutableCopy];
  if (![list containsObject:deviceId]) [list addObject:deviceId];
  [NSUserDefaults.standardUserDefaults setObject:list forKey:kTrustedKey];
}

- (NSString *)sixDigitCode {
  return [NSString stringWithFormat:@"%06u", arc4random_uniform(1000000)];
}

- (NSString *)newToken {
  NSMutableString *s = [NSMutableString string];
  for (int i = 0; i < 24; i++) [s appendFormat:@"%02x", arc4random_uniform(256)];
  return s;
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

#pragma mark - approval

- (void)askUserAbout:(BeamOffer *)offer files:(NSArray *)files {
  @synchronized(self) {
    _offers[offer.offerId] = offer;
  }
  if (!_hasListeners) return;
  [self sendEventWithName:@"beamApprovalRequest"
                     body:@{
                       @"id" : offer.offerId,
                       @"from" : offer.from ?: @"Unknown device",
                       @"code" : offer.code ?: @"",
                       @"canTrust" : @(offer.deviceId.length > 0),
                       @"files" : files ?: @[],
                     }];

  // Nobody answered in time: treat as declined so a stuck prompt can't hold a
  // legacy upload's temp files forever.
  __weak BeamReceiver *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kOfferTTL * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    BeamReceiver *self = weakSelf;
    if (!self) return;
    BeamOffer *o;
    @synchronized(self) {
      o = self->_offers[offer.offerId];
    }
    if (o && [o.status isEqualToString:@"pending"]) {
      o.status = @"declined";
      if (o.pendingSave) {
        void (^save)(BOOL) = o.pendingSave;
        o.pendingSave = nil;
        save(NO);
      }
    }
  });
}

/**
 * A tiny string store, so the JS side can keep its own lists (devices we've
 * seen, transfers we've made) without adding an async-storage dependency for
 * two small JSON blobs.
 */
RCT_EXPORT_METHOD(getStore:(NSString *)key
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject) {
  NSString *full = [@"BeamStore:" stringByAppendingString:key];
  resolve([NSUserDefaults.standardUserDefaults stringForKey:full] ?: [NSNull null]);
}

RCT_EXPORT_METHOD(setStore:(NSString *)key
                     value:(NSString *)value
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject) {
  NSString *full = [@"BeamStore:" stringByAppendingString:key];
  [NSUserDefaults.standardUserDefaults setObject:value forKey:full];
  resolve(@YES);
}

RCT_EXPORT_METHOD(respondToOffer:(NSString *)offerId
                        accepted:(BOOL)accepted
                           trust:(BOOL)trust
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject) {
  BeamOffer *offer;
  @synchronized(self) {
    offer = _offers[offerId];
  }
  if (!offer || ![offer.status isEqualToString:@"pending"]) {
    resolve(@NO);
    return;
  }
  if (accepted) {
    offer.token = [self newToken];
    offer.usesLeft = MAX(1, offer.fileCount);
    offer.status = @"accepted";
    if (trust) [self trustDevice:offer.deviceId];
  } else {
    offer.status = @"declined";
  }
  if (offer.pendingSave) {
    void (^save)(BOOL) = offer.pendingSave;
    offer.pendingSave = nil;
    save(accepted);
  }
  resolve(@YES);
}

RCT_EXPORT_METHOD(getDeviceId:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject) {
  resolve([self ownDeviceId]);
}

RCT_EXPORT_METHOD(listTrusted:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject) {
  resolve([self trustedIds]);
}

RCT_EXPORT_METHOD(forgetTrusted:(NSString *)deviceId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject) {
  NSMutableArray *list = [[self trustedIds] mutableCopy];
  [list removeObject:deviceId];
  [NSUserDefaults.standardUserDefaults setObject:list forKey:kTrustedKey];
  resolve(@YES);
}

#pragma mark - saving

/** Move already-received parts into Documents. Returns the saved names. */
- (NSArray<NSString *> *)saveFiles:(NSArray<GCDWebServerMultiPartFile *> *)files
                              from:(NSString *)sender {
  NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,
                                                       NSUserDomainMask, YES).firstObject;
  NSMutableArray *saved = [NSMutableArray array];
  for (GCDWebServerMultiPartFile *file in files) {
    NSString *name = file.fileName.lastPathComponent ?: @"unnamed";
    NSString *dest = [self uniqueDestinationFor:name inDir:docs];
    NSError *err = nil;
    [NSFileManager.defaultManager moveItemAtPath:file.temporaryPath toPath:dest error:&err];
    if (!err) {
      [saved addObject:dest.lastPathComponent];
      if (self->_hasListeners) {
        [self sendEventWithName:@"beamReceived"
                           body:@{
                             @"name" : dest.lastPathComponent,
                             @"uri" : dest,
                             @"sender" : sender ?: @"Device",
                           }];
      }
    }
  }
  return saved;
}

- (void)discardFiles:(NSArray<GCDWebServerMultiPartFile *> *)files {
  for (GCDWebServerMultiPartFile *file in files) {
    [NSFileManager.defaultManager removeItemAtPath:file.temporaryPath error:NULL];
  }
}

#pragma mark - lifecycle

RCT_EXPORT_METHOD(start:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  if (_server && _server.isRunning) {
    resolve(@{ @"port" : @(kBeamPort), @"name" : [self deviceName],
               @"deviceId" : [self ownDeviceId] });
    return;
  }

  _offers = [NSMutableDictionary dictionary];
  _server = [[GCDWebServer alloc] init];
  __weak BeamReceiver *weakSelf = self;

  [_server addHandlerForMethod:@"GET"
                          path:@"/info"
                  requestClass:[GCDWebServerRequest class]
                  processBlock:^GCDWebServerResponse *(GCDWebServerRequest *request) {
    BeamReceiver *self = weakSelf;
    return [GCDWebServerDataResponse responseWithJSONObject:@{
      @"app" : @"beam",
      @"name" : self ? [self deviceName] : @"iPhone",
      @"platform" : @"ios",
      @"version" : @"0.4.0",
      @"features" : @[ @"offer" ],
    }];
  }];

  // The sender declares itself; we answer at once and ask the user after.
  [_server addHandlerForMethod:@"POST"
                          path:@"/offer"
                  requestClass:[GCDWebServerDataRequest class]
                  processBlock:^GCDWebServerResponse *(GCDWebServerRequest *request) {
    BeamReceiver *self = weakSelf;
    if (!self) return [GCDWebServerDataResponse responseWithStatusCode:503];

    NSDictionary *body = [NSJSONSerialization
        JSONObjectWithData:[(GCDWebServerDataRequest *)request data]
                   options:0
                     error:NULL];
    NSArray *files = [body[@"files"] isKindOfClass:NSArray.class] ? body[@"files"] : @[];

    BeamOffer *offer = [BeamOffer new];
    offer.offerId = NSUUID.UUID.UUIDString;
    offer.from = body[@"from"] ?: @"Unknown device";
    offer.deviceId = body[@"deviceId"];
    offer.code = [self sixDigitCode];
    offer.status = @"pending";
    offer.fileCount = (NSInteger)files.count;
    offer.createdAt = NSDate.date;

    NSMutableDictionary *reply =
        [@{ @"id" : offer.offerId, @"code" : offer.code } mutableCopy];

    if ([self isTrusted:offer.deviceId]) {
      offer.token = [self newToken];
      offer.usesLeft = MAX(1, offer.fileCount);
      offer.status = @"accepted";
      @synchronized(self) {
        self->_offers[offer.offerId] = offer;
      }
      reply[@"status"] = @"accepted";
      reply[@"token"] = offer.token;
    } else {
      reply[@"status"] = @"pending";
      dispatch_async(dispatch_get_main_queue(), ^{
        [self askUserAbout:offer files:files];
      });
    }
    return [GCDWebServerDataResponse responseWithJSONObject:reply];
  }];

  [_server addHandlerForMethod:@"GET"
                     pathRegex:@"^/offer/.*"
                  requestClass:[GCDWebServerRequest class]
                  processBlock:^GCDWebServerResponse *(GCDWebServerRequest *request) {
    BeamReceiver *self = weakSelf;
    NSString *offerId = request.path.lastPathComponent;
    BeamOffer *offer;
    @synchronized(self) {
      offer = self->_offers[offerId];
    }
    if (!offer) {
      return [GCDWebServerDataResponse responseWithJSONObject:@{ @"status" : @"expired" }];
    }
    NSMutableDictionary *out = [@{ @"status" : offer.status } mutableCopy];
    if ([offer.status isEqualToString:@"accepted"]) out[@"token"] = offer.token;
    return [GCDWebServerDataResponse responseWithJSONObject:out];
  }];

  // Bytes. Async, because a legacy sender's upload has to wait for the user.
  [_server addHandlerForMethod:@"POST"
                          path:@"/upload"
                  requestClass:[GCDWebServerMultiPartFormRequest class]
             asyncProcessBlock:^(GCDWebServerRequest *request,
                                 GCDWebServerCompletionBlock completionBlock) {
    BeamReceiver *self = weakSelf;
    if (!self) return completionBlock([GCDWebServerDataResponse responseWithStatusCode:503]);

    GCDWebServerMultiPartFormRequest *upload = (GCDWebServerMultiPartFormRequest *)request;
    NSString *token = request.query[@"token"];
    NSString *sender = request.query[@"from"] ?: @"Device";

    if (token.length) {
      BeamOffer *match = nil;
      @synchronized(self) {
        for (BeamOffer *o in self->_offers.allValues) {
          if ([o.status isEqualToString:@"accepted"] && [o.token isEqualToString:token] &&
              o.usesLeft > 0) {
            match = o;
            break;
          }
        }
        if (match) {
          match.usesLeft -= 1;
          if (match.usesLeft == 0) match.status = @"used";
        }
      }
      if (!match) {
        [self discardFiles:upload.files];
        return completionBlock(BeamJSON(@{ @"error" : @"not approved" }, 403));
      }
      NSArray *saved = [self saveFiles:upload.files from:match.from];
      return completionBlock([GCDWebServerDataResponse
          responseWithJSONObject:@{ @"ok" : @YES, @"saved" : saved }]);
    }

    // No token: an older sender. iOS hands us the body already parsed, so the
    // bytes have arrived — but nothing is saved unless the user agrees, and the
    // temp files are deleted if they decline.
    BeamOffer *legacy = [BeamOffer new];
    legacy.offerId = NSUUID.UUID.UUIDString;
    legacy.from = sender;
    legacy.code = [self sixDigitCode];
    legacy.status = @"pending";
    legacy.fileCount = (NSInteger)upload.files.count;
    legacy.createdAt = NSDate.date;
    legacy.pendingSave = ^(BOOL accepted) {
      BeamReceiver *strong = weakSelf;
      if (!strong) return;
      if (!accepted) {
        [strong discardFiles:upload.files];
        completionBlock(BeamJSON(@{ @"error" : @"declined" }, 403));
        return;
      }
      NSArray *saved = [strong saveFiles:upload.files from:sender];
      completionBlock([GCDWebServerDataResponse
          responseWithJSONObject:@{ @"ok" : @YES, @"saved" : saved }]);
    };

    NSMutableArray *names = [NSMutableArray array];
    for (GCDWebServerMultiPartFile *f in upload.files) {
      [names addObject:@{ @"name" : f.fileName.lastPathComponent ?: @"file", @"size" : @0 }];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [self askUserAbout:legacy files:names];
    });
  }];

  NSError *error = nil;
  BOOL ok = [_server startWithOptions:@{
    GCDWebServerOption_Port : @(kBeamPort),
    GCDWebServerOption_BindToLocalhost : @NO,
    GCDWebServerOption_AutomaticallySuspendInBackground : @YES,
  } error:&error];

  if (ok) {
    resolve(@{ @"port" : @(kBeamPort), @"name" : [self deviceName],
               @"deviceId" : [self ownDeviceId] });
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
  @synchronized(self) {
    [_offers removeAllObjects];
  }
  resolve(nil);
}

@end
