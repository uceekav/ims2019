/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('shaka.Player');

goog.require('goog.asserts');
goog.require('shaka.Deprecate');
goog.require('shaka.log');
goog.require('shaka.media.ActiveStreamMap');
goog.require('shaka.media.AdaptationSetCriteria');
goog.require('shaka.media.BufferingObserver');
goog.require('shaka.media.DrmEngine');
goog.require('shaka.media.ManifestParser');
goog.require('shaka.media.MediaSourceEngine');
goog.require('shaka.media.MuxJSClosedCaptionParser');
goog.require('shaka.media.NoopCaptionParser');
goog.require('shaka.media.PeriodObserver');
goog.require('shaka.media.Playhead');
goog.require('shaka.media.PlayheadObserverManager');
goog.require('shaka.media.PreferenceBasedCriteria');
goog.require('shaka.media.RegionObserver');
goog.require('shaka.media.RegionTimeline');
goog.require('shaka.media.SegmentReference');
goog.require('shaka.media.StreamingEngine');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.text.SimpleTextDisplayer');
goog.require('shaka.util.ArrayUtils');
goog.require('shaka.util.Destroyer');
goog.require('shaka.util.Error');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.FakeEvent');
goog.require('shaka.util.FakeEventTarget');
goog.require('shaka.util.IDestroyable');
goog.require('shaka.util.ManifestParserUtils');
goog.require('shaka.util.MimeUtils');
goog.require('shaka.util.MultiMap');
goog.require('shaka.util.PlayerConfiguration');
goog.require('shaka.util.PublicPromise');
goog.require('shaka.util.Stats');
goog.require('shaka.util.StreamUtils');


/**
 * Construct a Player.
 *
 * @param {HTMLMediaElement=} mediaElem If provided, this is equivalent to
 *   calling attach(mediaElem, true) immediately after construction.
 * @param {function(shaka.Player)=} dependencyInjector Optional callback
 *   which is called to inject mocks into the Player.  Used for testing.
 *
 * @constructor
 * @struct
 * @implements {shaka.util.IDestroyable}
 * @extends {shaka.util.FakeEventTarget}
 * @export
 */
shaka.Player = function(mediaElem, dependencyInjector) {
  shaka.util.FakeEventTarget.call(this);

  /** @private {HTMLMediaElement} */
  this.video_ = null;

  /**
   * Since we may not always have a text displayer created (e.g. before |load|
   * is called), we need to track what text visibility SHOULD be so that we can
   * ensure that when we create the text displayer. When we create our text
   * displayer, we will use this to show (or not show) text as per the user's
   * requests.
   *
   * @private {boolean}
   */
  this.textVisibility_ = false;

  /** @private {shaka.util.EventManager} */
  this.eventManager_ = new shaka.util.EventManager();

  /** @private {shaka.net.NetworkingEngine} */
  this.networkingEngine_ = null;

  /** @private {shaka.media.DrmEngine} */
  this.drmEngine_ = null;

  /** @private {shaka.media.MediaSourceEngine} */
  this.mediaSourceEngine_ = null;

  /** @private {shaka.media.Playhead} */
  this.playhead_ = null;

  /**
   * The playhead observers are used to monitor the position of the playhead and
   * some other source of data (e.g. buffered content), and raise events.
   *
   * @private {shaka.media.PlayheadObserverManager}
   */
  this.playheadObservers_ = null;

  /** @private {shaka.media.RegionTimeline} */
  this.regionTimeline_ = null;

  /** @private {shaka.media.StreamingEngine} */
  this.streamingEngine_ = null;

  /** @private {shaka.extern.ManifestParser} */
  this.parser_ = null;

  /** @private {?shaka.extern.Manifest} */
  this.manifest_ = null;

  /** @private {?string} */
  this.assetUri_ = null;

  /** @private {shaka.extern.AbrManager} */
  this.abrManager_ = null;

  /**
   * The factory that was used to create the abrManager_ instance.
   * @private {?shaka.extern.AbrManager.Factory}
   */
  this.abrManagerFactory_ = null;

  /**
   * Contains an ID for use with creating streams.  The manifest parser should
   * start with small IDs, so this starts with a large one.
   * @private {number}
   */
  this.nextExternalStreamId_ = 1e9;

  /** @private {!Set.<shaka.extern.Stream>} */
  this.loadingTextStreams_ = new Set();

  /** @private {boolean} */
  this.buffering_ = false;

  /** @private {boolean} */
  this.switchingPeriods_ = true;

  /** @private {?function()} */
  this.onCancelLoad_ = null;

  /** @private {Promise} */
  this.unloadChain_ = null;

  /** @private {?shaka.extern.Variant} */
  this.deferredVariant_ = null;

  /** @private {boolean} */
  this.deferredVariantClearBuffer_ = false;

  /** @private {number} */
  this.deferredVariantClearBufferSafeMargin_ = 0;

  /** @private {?shaka.extern.Stream} */
  this.deferredTextStream_ = null;

  /**
   * A mapping of which streams are/were active in each period. Used when the
   * current period (the one containing playhead) differs from the active
   * period (the one being streamed in by streaming engine).
   *
   * @private {!shaka.media.ActiveStreamMap}
   */
  this.activeStreams_ = new shaka.media.ActiveStreamMap();

  /** @private {?shaka.extern.PlayerConfiguration} */
  this.config_ = this.defaultConfig_();

  /** @private {{width: number, height: number}} */
  this.maxHwRes_ = {width: Infinity, height: Infinity};

  /** @private {shaka.util.Stats} */
  this.stats_ = null;

  /** @private {!shaka.media.AdaptationSetCriteria} */
  this.currentAdaptationSetCriteria_ = new shaka.media.PreferenceBasedCriteria(
      this.config_.preferredAudioLanguage,
      this.config_.preferredVariantRole,
      this.config_.preferredAudioChannelCount);

  /** @private {string} */
  this.currentTextLanguage_ = this.config_.preferredTextLanguage;

  /** @private {string} */
  this.currentTextRole_ = this.config_.preferredTextRole;

  if (dependencyInjector) {
    dependencyInjector(this);
  }

  this.networkingEngine_ = this.createNetworkingEngine();

  if (mediaElem) {
    this.attach(mediaElem, true /* initializeMediaSource */);
  }

  /** @private {!shaka.util.Destroyer} */
  this.destroyer_ = new shaka.util.Destroyer(() => {
    if (this.eventManager_) {
      this.eventManager_.release();
      this.eventManager_ = null;
    }

    const waitFor = [];
    if (this.networkingEngine_) {
      waitFor.push(this.networkingEngine_.destroy());
      this.networkingEngine_ = null;
    }

    this.textVisibility_ = false;
    this.eventManager_ = null;
    this.abrManager_ = null;
    this.abrManagerFactory_ = null;
    this.config_ = null;

    return Promise.all(waitFor);
  });

  // If the browser comes back online after being offline, then try to play
  // again.
  this.eventManager_.listen(window, 'online', () => {
    this.retryStreaming();
  });
};

goog.inherits(shaka.Player, shaka.util.FakeEventTarget);


/**
 * @return {!Promise}
 * @private
 */
shaka.Player.prototype.cancelLoad_ = function() {
  if (!this.onCancelLoad_) {
    return Promise.resolve();
  }

  let stopParser = Promise.resolve();
  if (this.parser_) {
    // Stop the parser manually, to ensure that any network calls it may be
    // making are stopped in a timely fashion.
    // This happens in parallel with cancelling the load chain.
    // Otherwise, destroying will wait for any failing network calls to run
    // out of retries.
    stopParser = this.parser_.stop();
    this.parser_ = null;
  }
  return Promise.all([stopParser, this.onCancelLoad_()]);
};


/**
 * After destruction, a Player object cannot be used again.
 *
 * @override
 * @export
 */
shaka.Player.prototype.destroy = async function() {
  // First, detach from the media element.  This implies unloading content
  // and canceling pending loads.  This must be called before the destroyer
  // as it will indirectly check if the player has already been destroyed and
  // won't execute as expected.  Calling detach multiple times is safe, so it
  // is okay to be outside the protection of the destroyer.
  await this.detach();
  await this.destroyer_.destroy();
};


/**
 * @define {string} A version number taken from git at compile time.
 * @export
 */
shaka.Player.version = 'v2.5.0-beta3-uncompiled';

// Initialize the deprecation system using the version string we just set
// on the player.
shaka.Deprecate.init(shaka.Player.version);

/**
 * @event shaka.Player.ErrorEvent
 * @description Fired when a playback error occurs.
 * @property {string} type
 *   'error'
 * @property {!shaka.util.Error} detail
 *   An object which contains details on the error.  The error's 'category' and
 *   'code' properties will identify the specific error that occurred.  In an
 *   uncompiled build, you can also use the 'message' and 'stack' properties
 *   to debug.
 * @exportDoc
 */


/**
 * @event shaka.Player.EmsgEvent
 * @description Fired when a non-typical emsg is found in a segment.
 * @property {string} type
 *   'emsg'
 * @property {shaka.extern.EmsgInfo} detail
 *   An object which contains the content of the emsg box.
 * @exportDoc
 */


/**
 * @event shaka.Player.DrmSessionUpdateEvent
 * @description Fired when the CDM has accepted the license response.
 * @property {string} type
 *   'drmsessionupdate'
 * @exportDoc
 */


/**
 * @event shaka.Player.TimelineRegionAddedEvent
 * @description Fired when a media timeline region is added.
 * @property {string} type
 *   'timelineregionadded'
 * @property {shaka.extern.TimelineRegionInfo} detail
 *   An object which contains a description of the region.
 * @exportDoc
 */


/**
 * @event shaka.Player.TimelineRegionEnterEvent
 * @description Fired when the playhead enters a timeline region.
 * @property {string} type
 *   'timelineregionenter'
 * @property {shaka.extern.TimelineRegionInfo} detail
 *   An object which contains a description of the region.
 * @exportDoc
 */


/**
 * @event shaka.Player.TimelineRegionExitEvent
 * @description Fired when the playhead exits a timeline region.
 * @property {string} type
 *   'timelineregionexit'
 * @property {shaka.extern.TimelineRegionInfo} detail
 *   An object which contains a description of the region.
 * @exportDoc
 */


/**
 * @event shaka.Player.BufferingEvent
 * @description Fired when the player's buffering state changes.
 * @property {string} type
 *   'buffering'
 * @property {boolean} buffering
 *   True when the Player enters the buffering state.
 *   False when the Player leaves the buffering state.
 * @exportDoc
 */


/**
 * @event shaka.Player.LoadingEvent
 * @description Fired when the player begins loading.
 *   Used by the Cast receiver to determine idle state.
 * @property {string} type
 *   'loading'
 * @exportDoc
 */


/**
 * @event shaka.Player.UnloadingEvent
 * @description Fired when the player unloads or fails to load.
 *   Used by the Cast receiver to determine idle state.
 * @property {string} type
 *   'unloading'
 * @exportDoc
 */


/**
 * @event shaka.Player.TextTrackVisibilityEvent
 * @description Fired when text track visibility changes.
 * @property {string} type
 *   'texttrackvisibility'
 * @exportDoc
 */


/**
 * @event shaka.Player.TracksChangedEvent
 * @description Fired when the list of tracks changes.  For example, this will
 *   happen when changing periods or when track restrictions change.
 * @property {string} type
 *   'trackschanged'
 * @exportDoc
 */


/**
 * @event shaka.Player.AdaptationEvent
 * @description Fired when an automatic adaptation causes the active tracks
 *   to change.  Does not fire when the application calls selectVariantTrack()
 *   selectTextTrack(), selectAudioLanguage() or selectTextLanguage().
 * @property {string} type
 *   'adaptation'
 * @exportDoc
 */


/**
 * @event shaka.Player.VariantChangedEvent
 * @description Fired when a call from the application caused a variant change.
 *  Can be triggered by calls to selectVariantTrack() or selectAudioLanguage().
 *  Does not fire when an automatic adaptation causes a variant change.
 * @property {string} type
 *   'variantchanged'
 * @exportDoc
 */


/**
 * @event shaka.Player.TextChangedEvent
 * @description Fired when a call from the application caused a text stream
 *  change. Can be triggered by calls to selectTextTrack() or
 *  selectTextLanguage().
 * @property {string} type
 *   'textchanged'
 * @exportDoc
 */


/**
 * @event shaka.Player.ExpirationUpdatedEvent
 * @description Fired when there is a change in the expiration times of an
 *   EME session.
 * @property {string} type
 *   'expirationupdated'
 * @exportDoc
 */


/**
 * @event shaka.Player.LargeGapEvent
 * @description Fired when the playhead enters a large gap.  If
 *   |config.streaming.jumpLargeGaps| is set, the default action of this event
 *   is to jump the gap; this can be prevented by calling preventDefault() on
 *   the event object.
 * @property {string} type
 *   'largegap'
 * @property {number} currentTime
 *   The current time of the playhead.
 * @property {number} gapSize
 *   The size of the gap, in seconds.
 * @exportDoc
 */


/**
 * @event shaka.Player.StreamingEvent
 * @description Fired after the manifest has been parsed and track information
 *   is available, but before streams have been chosen and before any segments
 *   have been fetched.  You may use this event to configure the player based on
 *   information found in the manifest.
 * @property {string} type
 *   'streaming'
 * @exportDoc
 */


/**
 * These are the EME key statuses that represent restricted playback.
 * 'usable', 'released', 'output-downscaled', 'status-pending' are statuses
 * of the usable keys.  'expired' status is being handled separately in
 * DrmEngine.
 *
 * @const {!Array.<string>}
 * @private
 */
shaka.Player.restrictedStatuses_ = ['output-restricted', 'internal-error'];


/** @private {!Object.<string, function():*>} */
shaka.Player.supportPlugins_ = {};


/**
 * Registers a plugin callback that will be called with support().  The
 * callback will return the value that will be stored in the return value from
 * support().
 *
 * @param {string} name
 * @param {function():*} callback
 * @export
 */
shaka.Player.registerSupportPlugin = function(name, callback) {
  shaka.Player.supportPlugins_[name] = callback;
};


/**
 * Return whether the browser provides basic support.  If this returns false,
 * Shaka Player cannot be used at all.  In this case, do not construct a Player
 * instance and do not use the library.
 *
 * @return {boolean}
 * @export
 */
shaka.Player.isBrowserSupported = function() {
  // Basic features needed for the library to be usable.
  let basic = !!window.Promise && !!window.Uint8Array &&
              !!Array.prototype.forEach;

  return basic &&
      shaka.media.MediaSourceEngine.isBrowserSupported() &&
      shaka.media.DrmEngine.isBrowserSupported();
};


/**
 * Probes the browser to determine what features are supported.  This makes a
 * number of requests to EME/MSE/etc which may result in user prompts.  This
 * should only be used for diagnostics.
 *
 * NOTE: This may show a request to the user for permission.
 *
 * @see https://bit.ly/2ywccmH
 * @return {!Promise.<shaka.extern.SupportType>}
 * @export
 */
shaka.Player.probeSupport = function() {
  goog.asserts.assert(shaka.Player.isBrowserSupported(),
                      'Must have basic support');
  return shaka.media.DrmEngine.probeSupport().then(function(drm) {
    let manifest = shaka.media.ManifestParser.probeSupport();
    let media = shaka.media.MediaSourceEngine.probeSupport();
    let ret = {
      manifest: manifest,
      media: media,
      drm: drm,
    };

    let plugins = shaka.Player.supportPlugins_;
    for (let name in plugins) {
      ret[name] = plugins[name]();
    }

    return ret;
  });
};


/**
 * Attach the Player to a media element (audio or video tag).
 *
 * If the Player is already attached to a media element, the previous element
 * will first be detached.
 *
 * After calling attach, the media element is owned by the Player and should not
 * be used for other purposes until detach or destroy() are called.
 *
 * @param {!HTMLMediaElement} mediaElem
 * @param {boolean=} initializeMediaSource If true, start initializing
 *   MediaSource right away.  This can improve load() latency for
 *   MediaSource-based playbacks.  Defaults to true.
 *
 * @return {!Promise} If initializeMediaSource is false, the Promise is resolved
 *   as soon as the Player has released any previous media element and taken
 *   ownership of the new one.  If initializeMediaSource is true, the Promise
 *   resolves after MediaSource has been subsequently initialized on the new
 *   media element.
 * @export
 */
shaka.Player.prototype.attach =
    async function(mediaElem, initializeMediaSource) {
  if (initializeMediaSource === undefined) {
    initializeMediaSource = true;
  }

  if (this.video_) {
    await this.detach();
  }

  this.video_ = mediaElem;
  goog.asserts.assert(mediaElem, 'Cannot attach to a null media element!');

  // Listen for video errors.
  this.eventManager_.listen(this.video_, 'error',
      this.onVideoError_.bind(this));

  if (initializeMediaSource) {
    // Start the (potentially slow) process of opening MediaSource now.
    this.mediaSourceEngine_ = this.createMediaSourceEngine();
    await this.mediaSourceEngine_.open();
  }
};


/**
 * Detaches the Player from the media element (audio or video tag).
 *
 * After calling detach and waiting for the Promise to be resolved, the media
 * element is no longer owned by the Player and may be used for other purposes.
 *
 * @return {!Promise} Resolved when the Player has released any previous media
 *   element.
 * @export
 */
shaka.Player.prototype.detach = async function() {
  if (!this.video_) {
    return;
  }

  // Unload any loaded content.
  await this.unload(false /* reinitializeMediaSource */);

  // Stop listening for video errors.
  this.eventManager_.unlisten(this.video_, 'error');

  this.video_ = null;
};


/**
 * Get a parser for the asset located at |assetUri|.
 *
 * @param {string} assetUri
 * @param {?string} mimeType
 *    When not null, the mimeType will be used to find the best manifest parser
 *    for the given asset.
 * @return {!Promise.<shaka.extern.ManifestParser>}
 * @private
 */
shaka.Player.prototype.getParser_ = async function(assetUri, mimeType) {
  goog.asserts.assert(
      this.networkingEngine_,
      'Cannot call |getParser_| after calling |destroy|.');
  goog.asserts.assert(
      this.config_,
      'Cannot call |getParser_| after calling |destroy|');

  const parser = await shaka.media.ManifestParser.create(
      assetUri,
      this.networkingEngine_,
      this.config_.manifest.retryParameters,
      mimeType);

  return parser;
};


/**
 * Use the current state of the player and load the asset as a manifest. This
 * requires that |this.networkingEngine_|, |this.assetUri_|, and |this.parser_|
 * to have already been set.
 *
 * @return {!Promise.<shaka.extern.Manifest>} Resolves with the manifest.
 * @private
 */
shaka.Player.prototype.loadManifest_ = function() {
  goog.asserts.assert(
      this.networkingEngine_,
      'Cannot call |loadManifest_| after calling |destroy|.');
  goog.asserts.assert(
      this.assetUri_,
      'Cannot call |loadManifest_| after calling |destroy|.');
  goog.asserts.assert(
      this.parser_,
      'Cannot call |loadManifest_| after calling |destroy|.');

  this.regionTimeline_ = new shaka.media.RegionTimeline();
  this.regionTimeline_.setListeners(/* onRegionAdded */ (region) => {
    this.onRegionEvent_('timelineregionadded', region);
  });

  let playerInterface = {
    networkingEngine: this.networkingEngine_,
    filterNewPeriod: this.filterNewPeriod_.bind(this),
    filterAllPeriods: this.filterAllPeriods_.bind(this),

    // Called when the parser finds a timeline region. This can be called
    // before we start playback or during playback (live/in-progress manifest).
    onTimelineRegionAdded: (region) => this.regionTimeline_.addRegion(region),

    onEvent: this.onEvent_.bind(this),
    onError: this.onError_.bind(this),
  };

  return this.parser_.start(this.assetUri_, playerInterface);
};


/**
 * When there is a variant with video and audio, filter out all variants which
 * lack one or the other.
 * This is to avoid problems where we choose audio-only variants because they
 * have lower bandwidth, when there are variants with video available.
 *
 * @private
 */
shaka.Player.prototype.filterManifestForAVVariants_ = function() {
  const isAVVariant = (variant) => {
    // Audio-video variants may include both streams separately or may be single
    // multiplexed streams with multiple codecs.
    return (variant.video && variant.audio) ||
           (variant.video && variant.video.codecs.includes(','));
  };
  const hasAVVariant = this.manifest_.periods.some((period) => {
    return period.variants.some(isAVVariant);
  });
  if (hasAVVariant) {
    shaka.log.debug('Found variant with audio and video content, ' +
        'so filtering out audio-only content in all periods.');
    this.manifest_.periods.forEach((period) => {
      period.variants = period.variants.filter(isAVVariant);
    });
  }

  if (this.manifest_.periods.length == 0) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.NO_PERIODS);
  }
};


/**
 * Load a manifest.
 *
 * @param {string} assetUri
 * @param {?number=} startTime Optional start time, in seconds, to begin
 *   playback.
 *   Defaults to 0 for VOD and to the live edge for live.
 *   Set a positive number to start with a certain offset the beginning.
 *   Set a negative number to start with a certain offset from the end.  This is
 *   intended for use with live streams, to start at a fixed offset from the
 *   live edge.
 * @param {string|shaka.extern.ManifestParser.Factory=} mimeType
 *   The mime type for the content |manifestUri| points to or a manifest parser
 *   factory to override auto-detection or use an unregistered parser. Passing
 *   a manifest parser factory is deprecated and will be removed.
 * @return {!Promise} Resolved when the manifest has been loaded and playback
 *   has begun; rejected when an error occurs or the call was interrupted by
 *   destroy(), unload() or another call to load().
 * @export
 */
shaka.Player.prototype.load = async function(
    assetUri, startTime = null, mimeType) {
  if (!this.video_) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.PLAYER,
        shaka.util.Error.Code.NO_VIDEO_ELEMENT);
  }

  let cancelValue;
  /** @type {!shaka.util.PublicPromise} */
  const cancelPromise = new shaka.util.PublicPromise();
  const cancelCallback = () => {
    cancelValue = new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.PLAYER,
        shaka.util.Error.Code.LOAD_INTERRUPTED);
    return cancelPromise;
  };

  this.dispatchEvent(new shaka.util.FakeEvent('loading'));

  try {
    const video = this.video_;

    const unloadStart = Date.now();
    const unloadPromise = this.unload();
    this.onCancelLoad_ = cancelCallback;
    await unloadPromise;
    const unloadEnd = Date.now();

    // Not tracked in stats because it should be insignificant.
    // Logged in case it is not.
    shaka.log.debug('Unload latency:', (unloadEnd - unloadStart) / 1000);

    // We need to wait until we unloaded or else we would clash with a
    // previous sessions |stats_|.
    this.stats_ = new shaka.util.Stats(video);
    this.stats_.markStartOfLoad();

    this.eventManager_.listen(video, 'playing', () => {
      this.updateStateHistory_();
    });
    this.eventManager_.listen(video, 'pause', () => {
      this.updateStateHistory_();
    });
    this.eventManager_.listen(video, 'ended', () => {
      this.updateStateHistory_();
    });

    const AbrManagerFactory = this.config_.abrFactory;
    if (!this.abrManager_ || this.abrManagerFactory_ != AbrManagerFactory) {
      this.abrManagerFactory_ = AbrManagerFactory;
      this.abrManager_ = new AbrManagerFactory();
      this.abrManager_.configure(this.config_.abr);
    }

    if (cancelValue) throw cancelValue;

    /** @type {?shaka.extern.ManifestParser.Factory} */
    let Factory = null;
    /** @type {?string} */
    let contentMimeType = null;

    if (mimeType) {
      if (typeof mimeType == 'string') {
        contentMimeType = /** @type {string} */(mimeType);
      } else {
        shaka.Deprecate.deprecateFeature(
            2, 6,
            'Loading with a manifest parser factory',
            'Please register a manifest parser and for the mime-type.');

        Factory = /** @type {shaka.extern.ManifestParser.Factory} */(mimeType);
      }
    }

    this.parser_ = Factory ?
                   new Factory() :
                   await this.getParser_(assetUri, contentMimeType);

    this.parser_.configure(this.config_.manifest);

    this.assetUri_ = assetUri;

    const manifest = await this.loadManifest_();
    this.manifest_ = manifest;

    if (cancelValue) throw cancelValue;

    this.filterManifestForAVVariants_();

    this.drmEngine_ = await this.createDrmEngine(manifest);

    if (cancelValue) throw cancelValue;

    // Re-filter the manifest after DRM has been initialized.
    this.filterAllPeriods_(this.manifest_.periods);

    // TODO: When a manifest update adds a new period, that period's closed
    // captions should also be turned into text streams. This should be called
    // for each new period as well.
    this.createTextStreamsForClosedCaptions_(this.manifest_.periods);

    // Copy preferred languages from the config again, in case the config was
    // changed between construction and playback.
    this.currentAdaptationSetCriteria_ =
        new shaka.media.PreferenceBasedCriteria(
            this.config_.preferredAudioLanguage,
            this.config_.preferredVariantRole,
            this.config_.preferredAudioChannelCount);

    this.currentTextLanguage_ = this.config_.preferredTextLanguage;

    shaka.Player.applyPlayRange_(this.manifest_.presentationTimeline,
                                 this.config_.playRangeStart,
                                 this.config_.playRangeEnd);

    await this.drmEngine_.attach(video);

    if (cancelValue) throw cancelValue;

    this.abrManager_.init((variant, clearBuffer, safeMargin) => {
      return this.switch_(variant, clearBuffer, safeMargin);
    });

    if (!this.mediaSourceEngine_) {
      this.mediaSourceEngine_ = this.createMediaSourceEngine();
    }

    // TODO: If there's a default value in the function definition, startTime
    // can never be undefined.  Even if the caller explicitly passes undefined,
    // it will be assigned the default value.  So there is no reason for the
    // compiler to continue treating startTime as (number|null|undefined) when
    // the default value is null.  File a bug on the Closure compiler.
    goog.asserts.assert(startTime !== undefined, 'Cannot be undefined!');

    this.playhead_ = this.createPlayhead(startTime);
    this.playheadObservers_ = this.createPlayheadObservers_();

    this.streamingEngine_ = this.createStreamingEngine();
    this.streamingEngine_.configure(this.config_.streaming);

    // If the content is multi-codec and the browser can play more than one of
    // them, choose codecs now before we initialize streaming.
    this.chooseCodecsAndFilterManifest_();

    this.dispatchEvent(new shaka.util.FakeEvent('streaming'));

    await this.streamingEngine_.init();

    if (cancelValue) throw cancelValue;

    if (this.config_.streaming.startAtSegmentBoundary) {
      let time = this.adjustStartTime_(this.playhead_.getTime());
      this.playhead_.setStartTime(time);
    }

    // Re-filter the manifest after streams have been chosen.
    this.manifest_.periods.forEach(this.filterNewPeriod_.bind(this));
    // Dispatch a 'trackschanged' event now that all initial filtering is done.
    this.onTracksChanged_();
    // Since the first streams just became active, send an adaptation event.
    this.onAdaptation_();

    // Now that we've filtered out variants that aren't compatible with the
    // active one, update abr manager with filtered variants for the current
    // period.
    const currentPeriod = this.getPresentationPeriod_();
    const hasPrimary = currentPeriod.variants.some((v) => v.primary);

    if (!this.config_.preferredAudioLanguage && !hasPrimary) {
      shaka.log.warning('No preferred audio language set.  We will choose an ' +
                        'arbitrary language initially');
    }

    this.chooseVariant_(currentPeriod.variants);

    // Wait for the 'loadeddata' event to measure load() latency.
    this.eventManager_.listenOnce(video, 'loadeddata', () => {
      this.stats_.markEndOfLoad();
    });

    if (cancelValue) throw cancelValue;
    this.onCancelLoad_ = null;
  } catch (error) {
    // |error| will only be null if something returned |Promise.reject()|.
    if (error) {
      shaka.log.debug('load failed:', error, error.message, error.stack);
    } else {
      shaka.log.debug('load failed - missing error');
    }

    goog.asserts.assert(
        error instanceof shaka.util.Error,
        'Non-shaka error seen. This is an unhandled error.');

    // If we haven't started another load, clear the onCancelLoad_.
    cancelPromise.resolve();
    if (this.onCancelLoad_ == cancelCallback) {
      this.onCancelLoad_ = null;
      this.dispatchEvent(new shaka.util.FakeEvent('unloading'));
    }

    // If part of the load chain was aborted, that async call may have thrown.
    // In those cases, we want the cancelation error, not the thrown error.
    return Promise.reject(cancelValue || error);
  }
};


/**
 * In case of multiple usable codecs, choose one based on lowest average
 * bandwidth and filter out the rest.
 * @private
 */
shaka.Player.prototype.chooseCodecsAndFilterManifest_ = function() {
  // Collect a list of variants for all periods.
  /** @type {!Array.<shaka.extern.Variant>} */
  let variants = this.manifest_.periods.reduce(
      (variants, period) => variants.concat(period.variants), []);

  // To start, consider a subset of variants based on audio channel preferences.
  // For some content (#1013), surround-sound variants will use a different
  // codec than stereo variants, so it is important to choose codecs **after**
  // considering the audio channel config.
  variants = shaka.util.StreamUtils.filterVariantsByAudioChannelCount(
      variants, this.config_.preferredAudioChannelCount);

  function variantCodecs(variant) {
    // Only consider the base of the codec string.  For example, these should
    // both be considered the same codec: avc1.42c01e, avc1.4d401f
    let baseVideoCodec = '';
    if (variant.video) {
      baseVideoCodec = shaka.util.MimeUtils.getCodecBase(variant.video.codecs);
    }

    let baseAudioCodec = '';
    if (variant.audio) {
      baseAudioCodec = shaka.util.MimeUtils.getCodecBase(variant.audio.codecs);
    }

    return baseVideoCodec + '-' + baseAudioCodec;
  }

  // Now organize variants into buckets by codecs.
  /** @type {!shaka.util.MultiMap.<shaka.extern.Variant>} */
  const variantsByCodecs = new shaka.util.MultiMap();
  variants.forEach((variant) => {
    const group = variantCodecs(variant);
    variantsByCodecs.push(group, variant);
  });

  // Compute the average bandwidth for each group of variants.
  // Choose the lowest-bandwidth codecs.
  let bestCodecs = null;
  let lowestAverageBandwidth = Infinity;
  variantsByCodecs.forEach((codecs, variants) => {
    let sum = 0;
    let num = 0;
    variants.forEach(function(variant) {
      sum += variant.bandwidth || 0;
      ++num;
    });
    let averageBandwidth = sum / num;
    shaka.log.debug('codecs', codecs, 'avg bandwidth', averageBandwidth);

    if (averageBandwidth < lowestAverageBandwidth) {
      bestCodecs = codecs;
      lowestAverageBandwidth = averageBandwidth;
    }
  });
  goog.asserts.assert(bestCodecs != null, 'Should have chosen codecs!');
  goog.asserts.assert(!isNaN(lowestAverageBandwidth),
      'Bandwidth should be a number!');

  // Filter out any variants that don't match, forcing AbrManager to choose from
  // the most efficient variants possible.
  this.manifest_.periods.forEach(function(period) {
    period.variants = period.variants.filter(function(variant) {
      let codecs = variantCodecs(variant);
      if (codecs == bestCodecs) return true;

      shaka.log.debug('Dropping Variant (better codec available)', variant);
      return false;
    });
  });
};


/**
 * Create, configure, and initialize a new DrmEngine instance. This may be
 * replaced by tests to create fake instances instead.
 *
 * @param {shaka.extern.Manifest} manifest
 * @return {!Promise.<!shaka.media.DrmEngine>}
 */
shaka.Player.prototype.createDrmEngine = async function(manifest) {
  goog.asserts.assert(
      this.networkingEngine_,
      'Should not call |createDrmEngine| after |destroy|.');

  const playerInterface = {
    netEngine: this.networkingEngine_,
    onError: (e) => {
      this.onError_(e);
    },
    onKeyStatus: (map) => {
      this.onKeyStatus_(map);
    },
    onExpirationUpdated: (id, expiration) => {
      this.onExpirationUpdated_(id, expiration);
    },
    onEvent: (e) => {
      this.onEvent_(e);
    },
  };

  /** @type {!shaka.media.DrmEngine} */
  const drmEngine = new shaka.media.DrmEngine(playerInterface);
  drmEngine.configure(this.config_.drm);

  /** @type {!Array.<shaka.extern.Variant>} */
  const variants = shaka.util.StreamUtils.getAllVariants(manifest);
  await drmEngine.initForPlayback(variants, manifest.offlineSessionIds);

  return drmEngine;
};


/**
 * Creates a new instance of NetworkingEngine.  This can be replaced by tests
 * to create fake instances instead.
 *
 * @return {!shaka.net.NetworkingEngine}
 */
shaka.Player.prototype.createNetworkingEngine = function() {
  /** @type {function(number, number)} */
  const onProgressUpdated_ = (deltaTimeMs, numBytes) => {
    // In some situations, such as during offline storage, the abr manager might
    // not yet exist. Therefore, we need to check if abr manager has been
    // initialized before using it.
    if (this.abrManager_) {
      this.abrManager_.segmentDownloaded(deltaTimeMs, numBytes);
    }
  };

  return new shaka.net.NetworkingEngine(onProgressUpdated_);
};


/**
 * Creates a new instance of Playhead.  This can be replaced by tests to create
 * fake instances instead.
 *
 * @param {?number} startTime
 * @return {!shaka.media.Playhead}
 */
shaka.Player.prototype.createPlayhead = function(startTime) {
  goog.asserts.assert(this.manifest_, 'Must have manifest');
  goog.asserts.assert(this.video_, 'Must have video');
  return new shaka.media.Playhead(
      this.video_,
      this.manifest_.presentationTimeline,
      this.manifest_.minBufferTime || 0,
      this.config_.streaming,
      startTime,
      this.onSeek_.bind(this),
      this.onEvent_.bind(this));
};


/**
 * Create observers for the new playback session. The observers are responsible
 * for notifying the app and player of specific events.
 *
 * @return {!shaka.media.PlayheadObserverManager}
 * @private
 */
shaka.Player.prototype.createPlayheadObservers_ = function() {
  goog.asserts.assert(this.manifest_, 'Must have manifest');
  goog.asserts.assert(this.regionTimeline_, 'Must have region timeline');
  goog.asserts.assert(this.video_, 'Must have video element');

  // Create the period observer. This will allow us to notify the app when we
  // transition between periods.
  const periodObserver = new shaka.media.PeriodObserver(this.manifest_);
  periodObserver.setListeners((period) => this.onChangePeriod_());

  // Create the region observer. This will allow us to notify the app when we
  // move in and out of timeline regions.
  const regionObserver = new shaka.media.RegionObserver(this.regionTimeline_);
  const onEnterRegion = (region, seeking) => {
    this.onRegionEvent_('timelineregionenter', region);
  };
  const onExitRegion = (region, seeking) => {
    this.onRegionEvent_('timelineregionexit', region);
  };
  const onSkipRegion = (region, seeking) => {
    // If we are seeking, we don't want to surface the enter/exit events since
    // they didn't play through them.
    if (!seeking) {
      this.onRegionEvent_('timelineregionenter', region);
      this.onRegionEvent_('timelineregionexit', region);
    }
  };
  regionObserver.setListeners(onEnterRegion, onExitRegion, onSkipRegion);

  // Create the buffering observer. This will allow us to notify the player when
  // we are falling behind and something needs to be done before we run out of
  // buffering.

  // This is how much we need to buffer after we enter a starving state before
  // we can become satisfied again.
  const rebufferingThreshold = Math.max(
      this.manifest_.minBufferTime,
      this.config_.streaming.rebufferingGoal);
  const bufferingObserver = new shaka.media.BufferingObserver(
      /* starvingThreshold= */ rebufferingThreshold,
      /* startAs= */ shaka.media.BufferingObserver.State.STARVING,
      /* getSecondsBufferedAfter= */ (timeInSeconds) => {
        return shaka.media.TimeRangesUtils.bufferedAheadOf(
            this.video_.buffered, timeInSeconds);
      },
      /* isBufferedToEnd= */ () => {
        return this.isBufferedToEnd_();
      });
  const onBufferStarving = () => this.onBuffering_(/* isBuffering= */ true);
  const onBufferSatisfied = () => this.onBuffering_(/* isBuffering= */ false);
  bufferingObserver.setListeners(onBufferStarving, onBufferSatisfied);

  // Now that we have all our observers, create a manager for them.
  const manager = new shaka.media.PlayheadObserverManager(this.video_);
  manager.manage(periodObserver);
  manager.manage(regionObserver);
  manager.manage(bufferingObserver);

  return manager;
};


/**
 * Creates a new instance of MediaSourceEngine.  This can be replaced by tests
 * to create fake instances instead.
 *
 * @return {!shaka.media.MediaSourceEngine}
 */
shaka.Player.prototype.createMediaSourceEngine = function() {
  goog.asserts.assert(this.video_, 'video should be valid');

  const closedCaptionsParser =
      shaka.media.MuxJSClosedCaptionParser.isSupported() ?
      new shaka.media.MuxJSClosedCaptionParser() :
      new shaka.media.NoopCaptionParser();

  const TextDisplayerFactory = this.config_.textDisplayFactory;
  const textDisplayer = new TextDisplayerFactory();
  textDisplayer.setTextVisibility(this.textVisibility_);

  return new shaka.media.MediaSourceEngine(
      this.video_,
      closedCaptionsParser,
      textDisplayer);
};


/**
 * Creates a new instance of StreamingEngine.  This can be replaced by tests
 * to create fake instances instead.
 *
 * @return {!shaka.media.StreamingEngine}
 */
shaka.Player.prototype.createStreamingEngine = function() {
  goog.asserts.assert(
      this.playhead_ && this.mediaSourceEngine_ && this.manifest_,
      'Must not be destroyed');

  /** @type {shaka.media.StreamingEngine.PlayerInterface} */
  let playerInterface = {
    getPresentationTime: () => this.playhead_.getTime(),
    mediaSourceEngine: this.mediaSourceEngine_,
    netEngine: this.networkingEngine_,
    onChooseStreams: this.onChooseStreams_.bind(this),
    onCanSwitch: this.canSwitch_.bind(this),
    onError: this.onError_.bind(this),
    onEvent: this.onEvent_.bind(this),
    onManifestUpdate: this.onManifestUpdate_.bind(this),
    onSegmentAppended: this.onSegmentAppended_.bind(this),
  };

  return new shaka.media.StreamingEngine(this.manifest_, playerInterface);
};


/**
 * Configure the Player instance.
 *
 * The config object passed in need not be complete.  It will be merged with
 * the existing Player configuration.
 *
 * Config keys and types will be checked.  If any problems with the config
 * object are found, errors will be reported through logs and this returns
 * false.  If there are errors, valid config objects are still set.
 *
 * @param {string|!Object} config This should either be a field name or an
 *   object following the form of {@link shaka.extern.PlayerConfiguration},
 *   where you may omit any field you do not wish to change.
 * @param {*=} value This should be provided if the previous parameter
 *   was a string field name.
 * @return {boolean} True if the passed config object was valid, false if there
 *   were invalid entries.
 * @export
 */
shaka.Player.prototype.configure = function(config, value) {
  goog.asserts.assert(this.config_, 'Config must not be null!');
  goog.asserts.assert(typeof(config) == 'object' || arguments.length == 2,
                      'String configs should have values!');

  // ('fieldName', value) format
  if (arguments.length == 2 && typeof(config) == 'string') {
    config = this.convertToConfigObject_(config, value);
  }

  goog.asserts.assert(typeof(config) == 'object', 'Should be an object!');

  let ret = shaka.util.PlayerConfiguration.mergeConfigObjects(
      this.config_, config, this.defaultConfig_());

  this.applyConfig_();
  return ret;
};


/**
 * Convert config from ('fieldName', value) format to a partial
 * shaka.extern.PlayerConfiguration object.
 * E. g. from ('manifest.retryParameters.maxAttempts', 1) to
 * { manifest: { retryParameters: { maxAttempts: 1 }}}.
 *
 * @param {string} fieldName
 * @param {*} value
 * @return {!Object}
 * @private
 */
shaka.Player.prototype.convertToConfigObject_ = function(fieldName, value) {
  let configObject = {};
  let last = configObject;
  let searchIndex = 0;
  let nameStart = 0;
  while (true) {  // eslint-disable-line no-constant-condition
    let idx = fieldName.indexOf('.', searchIndex);
    if (idx < 0) {
      break;
    }
    if (idx == 0 || fieldName[idx - 1] != '\\') {
      let part = fieldName.substring(nameStart, idx).replace(/\\\./g, '.');
      last[part] = {};
      last = last[part];
      nameStart = idx + 1;
    }
    searchIndex = idx + 1;
  }

  last[fieldName.substring(nameStart).replace(/\\\./g, '.')] = value;
  return configObject;
};


/**
 * Apply config changes.
 * @private
 */
shaka.Player.prototype.applyConfig_ = function() {
  if (this.parser_) {
    this.parser_.configure(this.config_.manifest);
  }
  if (this.drmEngine_) {
    this.drmEngine_.configure(this.config_.drm);
  }
  if (this.streamingEngine_) {
    this.streamingEngine_.configure(this.config_.streaming);

    // Need to apply the restrictions to every period.
    try {
      // this.filterNewPeriod_() may throw.
      this.manifest_.periods.forEach(this.filterNewPeriod_.bind(this));
    } catch (error) {
      this.onError_(error);
    }

    // If the stream we are playing is restricted, we need to switch.
    let activeAudio = this.streamingEngine_.getBufferingAudio();
    let activeVideo = this.streamingEngine_.getBufferingVideo();
    let period = this.getPresentationPeriod_();
    let activeVariant = shaka.util.StreamUtils.getVariantByStreams(
        activeAudio, activeVideo, period.variants);
    if (this.abrManager_ && activeVariant &&
        activeVariant.allowedByApplication &&
        activeVariant.allowedByKeySystem) {
      // Update AbrManager variants to match these new settings.
      this.chooseVariant_(period.variants);
    } else {
      shaka.log.debug('Choosing new streams after changing configuration');
      this.chooseStreamsAndSwitch_(period);
    }
  }

  if (this.abrManager_) {
    this.abrManager_.configure(this.config_.abr);
    // Simply enable/disable ABR with each call, since multiple calls to these
    // methods have no effect.
    if (this.config_.abr.enabled && !this.switchingPeriods_) {
      this.abrManager_.enable();
    } else {
      this.abrManager_.disable();
    }
  }
};


/**
 * Return a copy of the current configuration.  Modifications of the returned
 * value will not affect the Player's active configuration.  You must call
 * player.configure() to make changes.
 *
 * @return {shaka.extern.PlayerConfiguration}
 * @export
 */
shaka.Player.prototype.getConfiguration = function() {
  goog.asserts.assert(this.config_, 'Config must not be null!');

  let ret = this.defaultConfig_();
  shaka.util.PlayerConfiguration.mergeConfigObjects(
      ret, this.config_, this.defaultConfig_());
  return ret;
};


/**
 * Return a reference to the current configuration. Modifications to the
 * returned value will affect the Player's active configuration. This method
 * is not exported as sharing configuration with external objects is not
 * supported.
 *
 * @return {shaka.extern.PlayerConfiguration}
 */
shaka.Player.prototype.getSharedConfiguration = function() {
  goog.asserts.assert(
      this.config_, 'Cannot call getSharedConfiguration after call destroy!');
  return this.config_;
};


/**
 * Reset configuration to default.
 * @export
 */
shaka.Player.prototype.resetConfiguration = function() {
  goog.asserts.assert(this.config_, 'Cannot be destroyed');
  // Remove the old keys so we remove open-ended dictionaries like drm.servers
  // but keeps the same object reference.
  for (const key in this.config_) {
    delete this.config_[key];
  }

  shaka.util.PlayerConfiguration.mergeConfigObjects(
      this.config_, this.defaultConfig_(), this.defaultConfig_());
  this.applyConfig_();
};


/**
 * @return {HTMLMediaElement} A reference to the HTML Media Element passed
 *     to the constructor or to attach().
 * @export
 */
shaka.Player.prototype.getMediaElement = function() {
  return this.video_;
};


/**
 * @return {shaka.net.NetworkingEngine} A reference to the Player's networking
 *     engine.  Applications may use this to make requests through Shaka's
 *     networking plugins.
 * @export
 */
shaka.Player.prototype.getNetworkingEngine = function() {
  return this.networkingEngine_;
};


/**
 * @return {?string} If an asset is loaded, returns the asset URI given in
 *   the last call to load().  Otherwise, returns null.
 * @export
 */
shaka.Player.prototype.getAssetUri = function() {
  return this.assetUri_;
};


/**
 * @return {?string} If a manifest is loaded, returns the manifest URI given in
 *   the last call to load().  Otherwise, returns null.
 * @export
 */
shaka.Player.prototype.getManifestUri = function() {
  shaka.Deprecate.deprecateFeature(
    2, 6, 'getManifestUri', 'Please use "getAssetUri" instead.');

  return this.assetUri_;
};


/**
 * @return {boolean} True if the current stream is live.  False otherwise.
 * @export
 */
shaka.Player.prototype.isLive = function() {
  return this.manifest_ ?
         this.manifest_.presentationTimeline.isLive() :
         false;
};


/**
 * @return {boolean} True if the current stream is in-progress VOD.
 *   False otherwise.
 * @export
 */
shaka.Player.prototype.isInProgress = function() {
  return this.manifest_ ?
         this.manifest_.presentationTimeline.isInProgress() :
         false;
};


/**
 * @return {boolean} True for audio-only content.  False otherwise.
 * @export
 */
shaka.Player.prototype.isAudioOnly = function() {
  if (!this.manifest_ || !this.manifest_.periods.length) {
    return false;
  }

  let variants = this.manifest_.periods[0].variants;
  if (!variants.length) {
    return false;
  }

  // Note that if there are some audio-only variants and some audio-video
  // variants, the audio-only variants are removed during filtering.
  // Therefore if the first variant has no video, that's sufficient to say it
  // is audio-only content.
  return !variants[0].video;
};


/**
 * Get the seekable range for the current stream.
 * @return {{start: number, end: number}}
 * @export
 */
shaka.Player.prototype.seekRange = function() {
  let start = 0;
  let end = 0;
  if (this.manifest_) {
    let timeline = this.manifest_.presentationTimeline;
    start = timeline.getSeekRangeStart();
    end = timeline.getSeekRangeEnd();
  }
  return {'start': start, 'end': end};
};


/**
 * Get the key system currently being used by EME.  This returns the empty
 * string if not using EME.
 *
 * @return {string}
 * @export
 */
shaka.Player.prototype.keySystem = function() {
  return this.drmEngine_ ? this.drmEngine_.keySystem() : '';
};


/**
 * Get the DrmInfo used to initialize EME.  This returns null when not using
 * EME.
 *
 * @return {?shaka.extern.DrmInfo}
 * @export
 */
shaka.Player.prototype.drmInfo = function() {
  return this.drmEngine_ ? this.drmEngine_.getDrmInfo() : null;
};


/**
 * The next known expiration time for any EME session.  If the sessions never
 * expire, or there are no EME sessions, this returns Infinity.
 *
 * @return {number}
 * @export
 */
shaka.Player.prototype.getExpiration = function() {
  return this.drmEngine_ ? this.drmEngine_.getExpiration() : Infinity;
};


/**
 * @return {boolean} True if the Player is in a buffering state.
 * @export
 */
shaka.Player.prototype.isBuffering = function() {
  return this.buffering_;
};


/**
 * Unload the current manifest and make the Player available for re-use.
 *
 * @param {boolean=} reinitializeMediaSource If true, start reinitializing
 *   MediaSource right away.  This can improve load() latency for
 *   MediaSource-based playbacks.  Defaults to true.
 * @return {!Promise} If reinitializeMediaSource is false, the Promise is
 *   resolved as soon as streaming has stopped and the previous content, if any,
 *   has been unloaded.  If reinitializeMediaSource is true or undefined, the
 *   Promise resolves after MediaSource has been subsequently reinitialized.
 * @export
 */
shaka.Player.prototype.unload = async function(reinitializeMediaSource) {
  if (this.destroyer_.destroyed()) {
    return;
  }

  if (reinitializeMediaSource === undefined) {
    reinitializeMediaSource = true;
  }

  this.dispatchEvent(new shaka.util.FakeEvent('unloading'));

  await this.cancelLoad_();

  // If there is an existing unload operation, use that.
  if (!this.unloadChain_) {
    this.unloadChain_ = this.destroyStreaming_().then(() => {
      // Force an exit from the buffering state.
      this.onBuffering_(false);
      this.unloadChain_ = null;
    });
  }
  await this.unloadChain_;

  if (reinitializeMediaSource) {
    // Start the (potentially slow) process of opening MediaSource now.
    this.mediaSourceEngine_ = this.createMediaSourceEngine();
    await this.mediaSourceEngine_.open();
  }
};


/**
 * Gets the current effective playback rate.  If using trick play, it will
 * return the current trick play rate; otherwise, it will return the video
 * playback rate.
 * @return {number}
 * @export
 */
shaka.Player.prototype.getPlaybackRate = function() {
  return this.playhead_ ? this.playhead_.getPlaybackRate() : 0;
};


/**
 * Skip through the content without playing.  Simulated using repeated seeks.
 *
 * Trick play will be canceled automatically if the playhead hits the beginning
 * or end of the seekable range for the content.
 *
 * @param {number} rate The playback rate to simulate.  For example, a rate of
 *     2.5 would result in 2.5 seconds of content being skipped every second.
 *     To trick-play backward, use a negative rate.
 * @export
 */
shaka.Player.prototype.trickPlay = function(rate) {
  shaka.log.debug('Trick play rate', rate);
  if (this.playhead_) {
    this.playhead_.setPlaybackRate(rate);
  }

  if (this.streamingEngine_) {
    this.streamingEngine_.setTrickPlay(rate != 1);
  }
};


/**
 * Cancel trick-play.
 * @export
 */
shaka.Player.prototype.cancelTrickPlay = function() {
  shaka.log.debug('Trick play canceled');
  if (this.playhead_) {
    this.playhead_.setPlaybackRate(1);
  }

  if (this.streamingEngine_) {
    this.streamingEngine_.setTrickPlay(false);
  }
};


/**
 * Return a list of variant tracks available for the current
 * Period.  If there are multiple Periods, then you must seek to the Period
 * before being able to switch.
 *
 * @return {!Array.<shaka.extern.Track>}
 * @export
 */
shaka.Player.prototype.getVariantTracks = function() {
  const currentVariant = this.getPresentationVariant_();

  const tracks = [];

  // Convert each variant to a track.
  for (const variant of this.getSelectableVariants_()) {
    const track = shaka.util.StreamUtils.variantToTrack(variant);
    track.active = variant == currentVariant;

    tracks.push(track);
  }

  return tracks;
};


/**
 * Return a list of text tracks available for the current
 * Period.  If there are multiple Periods, then you must seek to the Period
 * before being able to switch.
 *
 * @return {!Array.<shaka.extern.Track>}
 * @export
 */
shaka.Player.prototype.getTextTracks = function() {
  const currentText = this.getPresentationText_();

  const tracks = [];

  // Convert all selectable text streams to tracks.
  for (const text of this.getSelectableText_()) {
    const track = shaka.util.StreamUtils.textStreamToTrack(text);
    track.active = text == currentText;

    tracks.push(track);
  }

  return tracks;
};


/**
 * Select a specific text track.  Note that AdaptationEvents are not
 * fired for manual track selections.
 *
 * @param {shaka.extern.Track} track
 * @export
 */
shaka.Player.prototype.selectTextTrack = function(track) {
  const period = this.getPresentationPeriod_();

  // No period means we are not playing anything. If we are not playing
  // anything, we can't select anything.
  if (period == null) {
    return;
  }

  const stream = shaka.util.StreamUtils.findTextStreamForTrack(period, track);

  if (!stream) {
    shaka.log.error('Unable to find the track with id "' + track.id +
                    '"; did we change Periods?');
    return;
  }

  // Add entries to the history.
  this.addTextStreamToSwitchHistory_(
      period, stream, /* fromAdaptation= */ false);

  this.switchTextStream_(stream);

  // Workaround for https://github.com/google/shaka-player/issues/1299
  // When track is selected, back-propogate the language to
  // currentTextLanguage_.
  this.currentTextLanguage_ = stream.language;
};


/**
 * Find the CEA 608/708 text stream embedded in video, and switch to it.
 * @export
 */
shaka.Player.prototype.selectEmbeddedTextTrack = function() {
  shaka.Deprecate.deprecateFeature(
      2, 6,
      'selectEmbeddedTextTrack',
      [
        'If closed captions are signaled in the manifest, a text stream will',
        'be created to represent them. Please use SelectTextTrack.',
      ].join(' '));

  const tracks = this.getTextTracks().filter((track) => {
    return track.mimeType == shaka.util.MimeUtils.CLOSED_CAPTION_MIMETYPE;
  });
  if (tracks.length > 0) {
    this.selectTextTrack(tracks[0]);
  } else {
    shaka.log.warning('Unable to find the text track embedded in the video.');
  }
};


/**
 * @return {boolean} True if we are using any embedded text tracks present.
 * @export
 */
shaka.Player.prototype.usingEmbeddedTextTrack = function() {
  shaka.Deprecate.deprecateFeature(
      2, 6,
      'usingEmbeddedTextTrack',
      [
        'If closed captions are signaled in the manifest, a text stream will',
        'be created to represent them. There should be no reason to know if',
        'the player is playing embedded text.',
      ].join(' '));

  const activeText =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingText() : null;
  return activeText != null &&
      activeText.mimeType == shaka.util.MimeUtils.CLOSED_CAPTION_MIMETYPE;
};


/**
 * Select a specific track.  Note that AdaptationEvents are not fired for manual
 * track selections.
 *
 * @param {shaka.extern.Track} track
 * @param {boolean=} clearBuffer
 * @param {number=} safeMargin Optional amount of buffer (in seconds) to retain
 *   when clearing the buffer. Useful for switching variant quickly without
 *   causing a buffering event.
 *   Defaults to 0 if not provided. Ignored if clearBuffer is false.
 *   Can cause hiccups on some browsers if chosen too small, e.g. The amount of
 *   two segments is a fair minimum to consider as safeMargin value.
 * @export
 */
shaka.Player.prototype.selectVariantTrack = function(
    track, clearBuffer, safeMargin = 0) {
  const period = this.getPresentationPeriod_();

  // No period means we are not playing anything. If we are not playing
  // anything, we can't select anything.
  if (period == null) {
    return;
  }

  if (this.config_.abr.enabled) {
    shaka.log.alwaysWarn('Changing tracks while abr manager is enabled will ' +
                         'likely result in the selected track being ' +
                         'overriden. Consider disabling abr before calling ' +
                         'selectVariantTrack().');
  }

  const StreamUtils = shaka.util.StreamUtils;

  let variant = StreamUtils.findVariantForTrack(period, track);
  if (!variant) {
    shaka.log.error('Unable to locate track with id "' + track.id + '".');
    return;
  }

  // Double check that the track is allowed to be played.
  // The track list should only contain playable variants,
  // but if restrictions change and selectVariantTrack()
  // is called before the track list is updated, we could
  // get a now-restricted variant.
  let variantIsPlayable = StreamUtils.isPlayable(variant);
  if (!variantIsPlayable) {
    shaka.log.error('Unable to switch to track with id "' + track.id +
                    '" because it is restricted.');
    return;
  }

  // Add entries to the history.
  this.addVariantToSwitchHistory_(period, variant, /* fromAdaptation */ false);
  this.switchVariant_(variant, clearBuffer, safeMargin);

  // Workaround for https://github.com/google/shaka-player/issues/1299
  // When track is selected, back-propogate the language to
  // currentAudioLanguage_.
  this.currentAdaptationSetCriteria_ = new shaka.media.ExampleBasedCriteria(
      variant);

  // Update AbrManager variants to match these new settings.
  this.chooseVariant_(period.variants);
};


/**
 * Return a list of audio language-role combinations available for the current
 * Period.
 *
 * @return {!Array.<shaka.extern.LanguageRole>}
 * @export
 */
shaka.Player.prototype.getAudioLanguagesAndRoles = function() {
  // TODO: This assumes that language is always on the audio stream. This is not
  //       true when audio and video are muxed together.
  // TODO: If the language is on the video stream, how do roles affect the
  //       the language-role pairing?

  /** @type {!Array.<?shaka.extern.Stream>} */
  const audioStreams = [];
  for (const variant of this.getSelectableVariants_()) {
    audioStreams.push(variant.audio);
  }

  return shaka.Player.getLanguageAndRolesFrom_(audioStreams);
};


/**
 * Return a list of text language-role combinations available for the current
 * Period.
 *
 * @return {!Array.<shaka.extern.LanguageRole>}
 * @export
 */
shaka.Player.prototype.getTextLanguagesAndRoles = function() {
  return shaka.Player.getLanguageAndRolesFrom_(this.getSelectableText_());
};


/**
 * Return a list of audio languages available for the current Period.
 *
 * @return {!Array.<string>}
 * @export
 */
shaka.Player.prototype.getAudioLanguages = function() {
  // TODO: This assumes that language is always on the audio stream. This is not
  //       true when audio and video are muxed together.

  /** @type {!Array.<?shaka.extern.Stream>} */
  const audioStreams = [];
  for (const variant of this.getSelectableVariants_()) {
    audioStreams.push(variant.audio);
  }

  return Array.from(shaka.Player.getLanguagesFrom_(audioStreams));
};


/**
 * Return a list of text languages available for the current Period.
 *
 * @return {!Array.<string>}
 * @export
 */
shaka.Player.prototype.getTextLanguages = function() {
  return Array.from(shaka.Player.getLanguagesFrom_(this.getSelectableText_()));
};


/**
 * Sets currentAudioLanguage and currentVariantRole to the selected
 * language and role, and chooses a new variant if need be.
 *
 * @param {string} language
 * @param {string=} role
 * @export
 */
shaka.Player.prototype.selectAudioLanguage = function(language, role) {
  const period = this.getPresentationPeriod_();

  // No period means we are not playing anything. If we are not playing
  // anything, we can't select anything.
  if (period == null) {
    return;
  }

  this.currentAdaptationSetCriteria_ = new shaka.media.PreferenceBasedCriteria(
      language, role || '', 0);

  // TODO: Refactor to only change audio and not affect text.
  this.chooseStreamsAndSwitch_(period);
};


/**
 * Sets currentTextLanguage and currentTextRole to the selected
 * language and role, and chooses a new text stream if need be.
 *
 * @param {string} language
 * @param {string=} role
 * @export
 */
shaka.Player.prototype.selectTextLanguage = function(language, role) {
  const period = this.getPresentationPeriod_();

  // No period means we are not playing anything. If we are not playing
  // anything, we can't select anything.
  if (period == null) {
    return;
  }

  this.currentTextLanguage_ = language;
  this.currentTextRole_ = role || '';
  // TODO: Refactor to only change text and not affect audio.
  this.chooseStreamsAndSwitch_(period);
};


/**
 * @return {boolean} True if the current text track is visible.
 * @export
 */
shaka.Player.prototype.isTextTrackVisible = function() {
  // We always cache what the app wants so that even if we don't have anything
  // loaded, we know what will happen when we load content. Since we cache it,
  // we can always return the cached value, but assert that we are in sync.
  if (this.mediaSourceEngine_) {
    const displayer = this.mediaSourceEngine_.getTextDisplayer();
    goog.asserts.assert(
        this.textVisibility_ == displayer.isTextVisible(),
        'text visibility cache and actual are out of sync.');
  }

  return this.textVisibility_;
};


/**
 * Set the visibility of the current text track, if any.
 *
 * @param {boolean} on
 * @return {!Promise}
 * @export
 */
shaka.Player.prototype.setTextTrackVisibility = async function(on) {
  if (on == this.textVisibility_) {
    return;
  }

  if (this.mediaSourceEngine_) {
    this.mediaSourceEngine_.getTextDisplayer().setTextVisibility(on);
  }

  this.textVisibility_ = on;
  this.onTextTrackVisibility_();

  // If we always stream text, don't do anything special to StreamingEngine.
  if (this.config_.streaming.alwaysStreamText) {
    return;
  }

  // Load text stream when the user chooses to show the caption, and pause
  // loading text stream when the user chooses to hide the caption.
  if (!this.streamingEngine_) {
    return;
  }

  const StreamUtils = shaka.util.StreamUtils;

  if (on) {
    let period = this.getPresentationPeriod_();
    let textStreams = StreamUtils.filterStreamsByLanguageAndRole(
        period.textStreams,
        this.currentTextLanguage_,
        this.currentTextRole_);
    let stream = textStreams[0];
    if (stream) {
      await this.streamingEngine_.loadNewTextStream(stream);
    }
  } else {
    this.streamingEngine_.unloadTextStream();
  }
};


/**
 * Returns current playhead time as a Date.
 *
 * @return {Date}
 * @export
 */
shaka.Player.prototype.getPlayheadTimeAsDate = function() {
  if (!this.manifest_) return null;

  goog.asserts.assert(this.isLive(),
      'getPlayheadTimeAsDate should be called on a live stream!');

  let time =
      this.manifest_.presentationTimeline.getPresentationStartTime() * 1000 +
      this.video_.currentTime * 1000;

  return new Date(time);
};


/**
 * Returns the presentation start time as a Date.
 *
 * @return {Date}
 * @export
 */
shaka.Player.prototype.getPresentationStartTimeAsDate = function() {
  if (!this.manifest_) return null;

  goog.asserts.assert(this.isLive(),
      'getPresentationStartTimeAsDate should be called on a live stream!');

  let time =
      this.manifest_.presentationTimeline.getPresentationStartTime() * 1000;

  return new Date(time);
};


/**
 * Return the information about the current buffered ranges.
 *
 * @return {shaka.extern.BufferedInfo}
 * @export
 */
shaka.Player.prototype.getBufferedInfo = function() {
  if (!this.mediaSourceEngine_) {
    return {
      total: [],
      audio: [],
      video: [],
      text: [],
    };
  }

  return this.mediaSourceEngine_.getBufferedInfo();
};


/**
 * Return playback and adaptation stats.
 *
 * @return {shaka.extern.Stats}
 * @export
 */
shaka.Player.prototype.getStats = function() {
  // If we have no stats object it means that we have not loaded any content, so
  // return an empty stats blob.
  if (this.stats_ == null) {
    return shaka.util.Stats.getEmptyBlob();
  }

  this.stats_.updateTime(this.buffering_);
  this.updateStateHistory_();

  goog.asserts.assert(this.video_, 'If we have stats, we should have video_');
  const element = /** @type {!HTMLVideoElement} */ (this.video_);

  if (element.getVideoPlaybackQuality) {
    const info = element.getVideoPlaybackQuality();

    this.stats_.setDroppedFrames(
        Number(info.droppedVideoFrames),
        Number(info.totalVideoFrames));
  }

  const variant = this.getPresentationVariant_();

  if (variant) {
    this.stats_.setVariantBandwidth(variant.bandwidth);
  }

  if (variant && variant.video) {
    this.stats_.setResolution(
        /* width= */ variant.video.width || NaN,
        /* height= */ variant.video.height || NaN);
  }

  if (this.abrManager_) {
    const estimate = this.abrManager_.getBandwidthEstimate();
    this.stats_.setBandwidthEstimate(estimate);
  }

  return this.stats_.getBlob();
};


/**
 * Adds the given text track to the current Period.  load() must resolve before
 * calling.  The current Period or the presentation must have a duration.  This
 * returns a Promise that will resolve with the track that was created, when
 * that track can be switched to.
 *
 * @param {string} uri
 * @param {string} language
 * @param {string} kind
 * @param {string} mime
 * @param {string=} codec
 * @param {string=} label
 * @return {!Promise.<shaka.extern.Track>}
 * @export
 */
shaka.Player.prototype.addTextTrack = function(
    uri, language, kind, mime, codec, label) {
  /** @type {?shaka.extern.Period} */
  const period = this.getPresentationPeriod_();

  // We need to be playing something before we add text tracks. If we don't have
  // a period, it means we are not playing anything.
  if (period == null) {
    shaka.log.error(
        'Must call load() and wait for it to resolve before adding text ' +
        'tracks.');
    return Promise.reject();
  }

  const ContentType = shaka.util.ManifestParserUtils.ContentType;

  // Get the Period duration.
  /** @type {number} */
  const periodIndex = this.manifest_.periods.indexOf(period);
  /** @type {number} */
  const nextPeriodIndex = periodIndex + 1;
  /** @type {number} */
  const nextPeriodStart = nextPeriodIndex >= this.manifest_.periods.length ?
                          this.manifest_.presentationTimeline.getDuration() :
                          this.manifest_.periods[nextPeriodIndex].startTime;
  /** @type {number} */
  const periodDuration = nextPeriodStart - period.startTime;
  if (periodDuration == Infinity) {
    return Promise.reject(new shaka.util.Error(
        shaka.util.Error.Severity.RECOVERABLE,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.CANNOT_ADD_EXTERNAL_TEXT_TO_LIVE_STREAM));
  }

  /** @type {shaka.extern.Stream} */
  let stream = {
    id: this.nextExternalStreamId_++,
    originalId: null,
    createSegmentIndex: Promise.resolve.bind(Promise),
    findSegmentPosition: function(time) { return 1; },
    getSegmentReference: function(ref) {
      if (ref != 1) return null;
      return new shaka.media.SegmentReference(
          1, 0, periodDuration, function() { return [uri]; }, 0, null);
    },
    initSegmentReference: null,
    presentationTimeOffset: 0,
    mimeType: mime,
    codecs: codec || '',
    kind: kind,
    encrypted: false,
    keyId: null,
    language: language,
    label: label || null,
    type: ContentType.TEXT,
    primary: false,
    trickModeVideo: null,
    emsgSchemeIdUris: null,
    roles: [],
    channelsCount: null,
    closedCaptions: null,
  };

  // Add the stream to the loading list to ensure it isn't switched to while it
  // is initializing.
  this.loadingTextStreams_.add(stream);
  period.textStreams.push(stream);

  return this.streamingEngine_.loadNewTextStream(stream)
          .then(function() {
    if (this.destroyer_.destroyed()) {
      return;
    }

    goog.asserts.assert(period, 'The period should still be non-null here.');

    const activeText = this.streamingEngine_.getBufferingText();
    if (activeText) {
      // If this was the first text stream, StreamingEngine will start streaming
      // it in loadNewTextStream.  To reflect this, update the active stream.
      this.activeStreams_.useText(period, activeText);
    }
    // Remove the stream from the loading list.
    this.loadingTextStreams_.delete(stream);

    shaka.log.debug('Choosing new streams after adding a text stream');
    this.chooseStreamsAndSwitch_(period);
    this.onTracksChanged_();

    return {
      id: stream.id,
      active: false,
      type: ContentType.TEXT,
      bandwidth: 0,
      language: language,
      label: label || null,
      kind: kind,
      width: null,
      height: null,
    };
  }.bind(this));
};


/**
 * Set the maximum resolution that the platform's hardware can handle.
 * This will be called automatically by shaka.cast.CastReceiver to enforce
 * limitations of the Chromecast hardware.
 *
 * @param {number} width
 * @param {number} height
 * @export
 */
shaka.Player.prototype.setMaxHardwareResolution = function(width, height) {
  this.maxHwRes_.width = width;
  this.maxHwRes_.height = height;
};


/**
 * Retry streaming after a failure.  Does nothing if not in a failure state.
 * @return {boolean} False if unable to retry.
 * @export
 */
shaka.Player.prototype.retryStreaming = function() {
  return this.streamingEngine_ ? this.streamingEngine_.retry() : false;
};


/**
 * Return the manifest information if it's loaded. Otherwise, return null.
 * @return {?shaka.extern.Manifest}
 * @export
 */
shaka.Player.prototype.getManifest = function() {
  return this.manifest_;
};


/**
 * @param {shaka.extern.Period} period
 * @param {shaka.extern.Variant} variant
 * @param {boolean} fromAdaptation
 * @private
 */
shaka.Player.prototype.addVariantToSwitchHistory_ = function(
    period, variant, fromAdaptation) {
  this.activeStreams_.useVariant(period, variant);
  this.stats_.getSwitchHistory().updateCurrentVariant(variant, fromAdaptation);
};


/**
 * @param {shaka.extern.Period} period
 * @param {shaka.extern.Stream} textStream
 * @param {boolean} fromAdaptation
 * @private
 */
shaka.Player.prototype.addTextStreamToSwitchHistory_ = function(
    period, textStream, fromAdaptation) {
  this.activeStreams_.useText(period, textStream);
  this.stats_.getSwitchHistory().updateCurrentText(textStream, fromAdaptation);
};


/**
 * Destroy members responsible for streaming.
 *
 * @return {!Promise}
 * @private
 */
shaka.Player.prototype.destroyStreaming_ = function() {
  if (this.eventManager_) {
    this.eventManager_.unlisten(this.video_, 'loadeddata');
    this.eventManager_.unlisten(this.video_, 'playing');
    this.eventManager_.unlisten(this.video_, 'pause');
    this.eventManager_.unlisten(this.video_, 'ended');
  }

  // Some observers use some of our components, so we should shut them down
  // first so that they don't try to use the components we are about to
  // destroy.
  if (this.playheadObservers_) {
    this.playheadObservers_.release();
    this.playheadObservers_ = null;
  }

  if (this.playhead_) {
    this.playhead_.release();
    this.playhead_ = null;
  }

  const drmEngine = this.drmEngine_;
  let p = Promise.all([
    this.abrManager_ ? this.abrManager_.stop() : null,
    this.mediaSourceEngine_ ? this.mediaSourceEngine_.destroy() : null,
    this.streamingEngine_ ? this.streamingEngine_.destroy() : null,
    this.parser_ ? this.parser_.stop() : null,
  ]).then(() => {
    // MediaSourceEngine must be destroyed before DrmEngine, so that DrmEngine
    // can detach MediaKeys from the media element.
    return drmEngine ? drmEngine.destroy() : null;
  });

  // The region timeline is used by the parser, so it must be released after
  // we stop the parser.
  if (this.regionTimeline_) {
    this.regionTimeline_.release();
    this.regionTimeline_ = null;
  }

  this.switchingPeriods_ = true;
  this.drmEngine_ = null;
  this.mediaSourceEngine_ = null;
  this.streamingEngine_ = null;
  this.parser_ = null;
  this.manifest_ = null;
  this.assetUri_ = null;
  this.activeStreams_.clear();
  this.loadingTextStreams_.clear();
  this.stats_ = null;

  return p;
};


/**
 * @return {shaka.extern.PlayerConfiguration}
 * @private
 */
shaka.Player.prototype.defaultConfig_ = function() {
  const config = shaka.util.PlayerConfiguration.createDefault();

  config.streaming.failureCallback = (error) => {
    this.defaultStreamingFailureCallback_(error);
  };

  // Because this.video_ may not be set when the config is built, the default
  // TextDisplay factory must capture a reference to "this" as "self" to use at
  // the time we call the factory.  Bind can't be used here because we call the
  // factory with "new", effectively removing any binding to "this".
  const self = this;
  config.textDisplayFactory = function() {
    return new shaka.text.SimpleTextDisplayer(self.video_);
  };

  return config;
};


/**
 * @param {!shaka.util.Error} error
 * @private
 */
shaka.Player.prototype.defaultStreamingFailureCallback_ = function(error) {
  let retryErrorCodes = [
    shaka.util.Error.Code.BAD_HTTP_STATUS,
    shaka.util.Error.Code.HTTP_ERROR,
    shaka.util.Error.Code.TIMEOUT,
  ];

  if (this.isLive() && retryErrorCodes.includes(error.code)) {
    error.severity = shaka.util.Error.Severity.RECOVERABLE;

    shaka.log.warning('Live streaming error.  Retrying automatically...');
    this.retryStreaming();
  }
};


/**
 * For CEA closed captions embedded in the video streams, create dummy text
 * stream.
 * @param {!Array.<!shaka.extern.Period>} periods
 * @private
 */
shaka.Player.prototype.createTextStreamsForClosedCaptions_ = function(periods) {
  const ContentType = shaka.util.ManifestParserUtils.ContentType;

  for (let periodIndex = 0; periodIndex < periods.length; periodIndex++) {
    const period = periods[periodIndex];
    // A map of the closed captions id and the new dummy text stream.
    let closedCaptionsMap = new Map();
    for (let variant of period.variants) {
      if (variant.video && variant.video.closedCaptions) {
        let video = variant.video;
        for (const id of video.closedCaptions.keys()) {
          if (!closedCaptionsMap.has(id)) {
            let textStream = {
              id: this.nextExternalStreamId_++,  // A globally unique ID.
              originalId: id, // The CC ID string, like 'CC1', 'CC3', etc.
              createSegmentIndex: Promise.resolve.bind(Promise),
              findSegmentPosition: (time) => { return null; },
              getSegmentReference: (ref) => { return null; },
              initSegmentReference: null,
              presentationTimeOffset: 0,
              mimeType: shaka.util.MimeUtils.CLOSED_CAPTION_MIMETYPE,
              codecs: '',
              kind:
                  shaka.util.ManifestParserUtils.TextStreamKind.CLOSED_CAPTION,
              encrypted: false,
              keyId: null,
              language: video.closedCaptions.get(id),
              label: null,
              type: ContentType.TEXT,
              primary: false,
              trickModeVideo: null,
              emsgSchemeIdUris: null,
              roles: video.roles,
              channelsCount: null,
              closedCaptions: null,
            };
            closedCaptionsMap.set(id, textStream);
          }
        }
      }
    }
    for (const textStream of closedCaptionsMap.values()) {
      period.textStreams.push(textStream);
    }
  }
};


/**
 * Filters a list of periods.
 * @param {!Array.<!shaka.extern.Period>} periods
 * @private
 */
shaka.Player.prototype.filterAllPeriods_ = function(periods) {
  goog.asserts.assert(this.video_, 'Must not be destroyed');
  const ArrayUtils = shaka.util.ArrayUtils;
  const StreamUtils = shaka.util.StreamUtils;

  /** @type {?shaka.extern.Stream} */
  let activeAudio =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingAudio() : null;
  /** @type {?shaka.extern.Stream} */
  let activeVideo =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingVideo() : null;

  let filterPeriod = StreamUtils.filterNewPeriod.bind(
      null, this.drmEngine_, activeAudio, activeVideo);
  periods.forEach(filterPeriod);

  let validPeriodsCount = ArrayUtils.count(periods, function(period) {
    return period.variants.some(StreamUtils.isPlayable);
  });

  // If none of the periods are playable, throw CONTENT_UNSUPPORTED_BY_BROWSER.
  if (validPeriodsCount == 0) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.CONTENT_UNSUPPORTED_BY_BROWSER);
  }

  // If only some of the periods are playable, throw UNPLAYABLE_PERIOD.
  if (validPeriodsCount < periods.length) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.UNPLAYABLE_PERIOD);
  }

  periods.forEach(function(period) {
    let tracksChanged = shaka.util.StreamUtils.applyRestrictions(
        period.variants, this.config_.restrictions, this.maxHwRes_);
    if (tracksChanged && this.streamingEngine_ &&
        this.getPresentationPeriod_() == period) {
      this.onTracksChanged_();
    }

    this.checkRestrictedVariants_(period.variants);
  }.bind(this));
};


/**
 * Filters a new period.
 * @param {shaka.extern.Period} period
 * @private
 */
shaka.Player.prototype.filterNewPeriod_ = function(period) {
  goog.asserts.assert(this.video_, 'Must not be destroyed');
  const StreamUtils = shaka.util.StreamUtils;

  /** @type {?shaka.extern.Stream} */
  let activeAudio =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingAudio() : null;
  /** @type {?shaka.extern.Stream} */
  let activeVideo =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingVideo() : null;

  StreamUtils.filterNewPeriod(
      this.drmEngine_, activeAudio, activeVideo, period);

  /** @type {!Array.<shaka.extern.Variant>} */
  let variants = period.variants;

  // Check for playable variants before restrictions, so that we can give a
  // special error when there were tracks but they were all filtered.
  const hasPlayableVariant = variants.some(StreamUtils.isPlayable);
  if (!hasPlayableVariant) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.UNPLAYABLE_PERIOD);
  }

  this.checkRestrictedVariants_(period.variants);

  const tracksChanged = shaka.util.StreamUtils.applyRestrictions(
      variants, this.config_.restrictions, this.maxHwRes_);

  // Trigger the track change event if the restrictions now prevent use from
  // using a variant that we previously thought we could use.
  if (tracksChanged && this.streamingEngine_ &&
      this.getPresentationPeriod_() == period) {
    this.onTracksChanged_();
  }

  // For new Periods, we may need to create new sessions for any new init data.
  const curDrmInfo = this.drmEngine_ ? this.drmEngine_.getDrmInfo() : null;
  if (curDrmInfo) {
    for (const variant of variants) {
      for (const drmInfo of variant.drmInfos) {
        // Ignore any data for different key systems.
        if (drmInfo.keySystem == curDrmInfo.keySystem) {
          for (const initData of (drmInfo.initData || [])) {
            this.drmEngine_.newInitData(
                initData.initDataType, initData.initData);
          }
        }
      }
    }
  }
};


/**
 * Switches to the given variant, deferring if needed.
 * @param {shaka.extern.Variant} variant
 * @param {boolean=} clearBuffer
 * @param {number=} safeMargin
 * @private
 */
shaka.Player.prototype.switchVariant_ =
    function(variant, clearBuffer = false, safeMargin = 0) {
  if (this.switchingPeriods_) {
    // Store this action for later.
    this.deferredVariant_ = variant;
    this.deferredVariantClearBuffer_ = clearBuffer;
    this.deferredVariantClearBufferSafeMargin_ = safeMargin;
  } else {
    // Act now.
    this.streamingEngine_.switchVariant(variant, clearBuffer, safeMargin);
    // Dispatch a 'variantchanged' event
    this.onVariantChanged_();
  }
};


/**
 * Switches to the given text stream, deferring if needed.
 * @param {shaka.extern.Stream} textStream
 * @private
 */
shaka.Player.prototype.switchTextStream_ = function(textStream) {
  if (this.switchingPeriods_) {
    // Store this action for later.
    this.deferredTextStream_ = textStream;
  } else {
    // Act now.
    this.streamingEngine_.switchTextStream(textStream);
    this.onTextChanged_();
  }
};


/**
 * Verifies that the active streams according to the player match those in
 * StreamingEngine.
 * @private
 */
shaka.Player.prototype.assertCorrectActiveStreams_ = function() {
  if (!this.streamingEngine_ || !this.manifest_ || !goog.DEBUG) return;

  const activePeriod = this.streamingEngine_.getBufferingPeriod();
  const currentPeriod = this.getPresentationPeriod_();
  if (activePeriod == null || activePeriod != currentPeriod) {
    return;
  }

  let activeAudio = this.streamingEngine_.getBufferingAudio();
  let activeVideo = this.streamingEngine_.getBufferingVideo();
  let activeText = this.streamingEngine_.getBufferingText();

  // If we have deferred variants/text we want to compare against those rather
  // than what we are actually streaming.
  const expectedAudio = this.deferredVariant_ ?
                        this.deferredVariant_.audio :
                        activeAudio;

  const expectedVideo = this.deferredVariant_ ?
                        this.deferredVariant_.video :
                        activeVideo;

  const expectedText = this.deferredTextStream_ || activeText;

  const actualVariant = this.activeStreams_.getVariant(currentPeriod);
  const actualText = this.activeStreams_.getText(currentPeriod);

  goog.asserts.assert(
      actualVariant.audio == expectedAudio,
      'Inconsistent active audio stream');
  goog.asserts.assert(
      actualVariant.video == expectedVideo,
      'Inconsistent active video stream');

  // Because we always set a text stream to be active in the active stream map,
  // regardless of whether or not we are actually streaming text, it is possible
  // for these to be out of line.
  goog.asserts.assert(
      expectedText == null || actualText == expectedText,
      'Inconsistent active text stream');
};


/**
 * @param {number} time
 * @return {number}
 * @private
 */
shaka.Player.prototype.adjustStartTime_ = function(time) {
  /** @type {?shaka.extern.Stream} */
  let activeAudio = this.streamingEngine_.getBufferingAudio();
  /** @type {?shaka.extern.Stream} */
  let activeVideo = this.streamingEngine_.getBufferingVideo();
  /** @type {?shaka.extern.Period} */
  let period = this.getPresentationPeriod_();

  // This method is called after StreamingEngine.init resolves, which means that
  // all the active streams have had createSegmentIndex called.
  function getAdjustedTime(stream, time) {
    if (!stream) return null;
    let idx = stream.findSegmentPosition(time - period.startTime);
    if (idx == null) return null;
    let ref = stream.getSegmentReference(idx);
    if (!ref) return null;
    let refTime = ref.startTime + period.startTime;
    goog.asserts.assert(refTime <= time, 'Segment should start before time');
    return refTime;
  }

  let audioStartTime = getAdjustedTime(activeAudio, time);
  let videoStartTime = getAdjustedTime(activeVideo, time);

  // If we have both video and audio times, pick the larger one.  If we picked
  // the smaller one, that one will download an entire segment to buffer the
  // difference.
  if (videoStartTime != null && audioStartTime != null) {
    return Math.max(videoStartTime, audioStartTime);
  } else if (videoStartTime != null) {
    return videoStartTime;
  } else if (audioStartTime != null) {
    return audioStartTime;
  } else {
    return time;
  }
};


/**
 * Callback from PlayheadObserver.
 *
 * @param {boolean} buffering
 * @private
 */
shaka.Player.prototype.onBuffering_ = function(buffering) {
  // Before setting |buffering_|, update the time spent in the previous state.
  // We must check |stats_| first because we call |onBuffering_| after
  // unloading.
  if (this.stats_) {
    this.stats_.updateTime(this.buffering_);
  }

  this.buffering_ = buffering;
  this.updateStateHistory_();

  if (this.playhead_) {
    this.playhead_.setBuffering(buffering);
  }

  let event = new shaka.util.FakeEvent('buffering', {'buffering': buffering});
  this.dispatchEvent(event);
};


/**
 * Callback from PlayheadObserver.
 * @private
 */
shaka.Player.prototype.onChangePeriod_ = function() {
  this.onTracksChanged_();
};


/**
 * Called from potential initiators of state changes, or before returning stats
 * to the user.
 *
 * This method decides if state has actually changed, updates the last entry,
 * and adds a new one if needed.
 *
 * @private
 */
shaka.Player.prototype.updateStateHistory_ = function() {
  if (this.stats_) {
    this.stats_.getStateHistory().update(this.buffering_);
  }
};


/**
 * Callback from Playhead.
 *
 * @private
 */
shaka.Player.prototype.onSeek_ = function() {
  if (this.playheadObservers_) {
    this.playheadObservers_.notifyOfSeek();
  }
  if (this.streamingEngine_) {
    this.streamingEngine_.seeked();
  }
};


/**
 * Chooses a variant from all possible variants while taking into account
 * restrictions, preferences, and ABR.
 *
 * On error, this dispatches an error event and returns null.
 *
 * @param {!Array.<shaka.extern.Variant>} allVariants
 * @return {?shaka.extern.Variant}
 * @private
 */
shaka.Player.prototype.chooseVariant_ = function(allVariants) {
  goog.asserts.assert(this.config_, 'Must not be destroyed');

  try {
    // |variants| are the filtered variants, use |period.variants| so we know
    // why they we restricted.
    this.checkRestrictedVariants_(allVariants);
  } catch (e) {
    this.onError_(e);
    return null;
  }

  goog.asserts.assert(
      allVariants.length, 'Should have thrown for no Variants.');

  const playableVariants = allVariants.filter((variant) => {
    return shaka.util.StreamUtils.isPlayable(variant);
  });

  // Update the abr manager with newly filtered variants.
  const adaptationSet = this.currentAdaptationSetCriteria_.create(
      playableVariants);
  this.abrManager_.setVariants(Array.from(adaptationSet.values()));
  return this.abrManager_.chooseVariant();
};


/**
 * Choose a text stream from all possible text streams while taking into
 * account user preference.
 *
 * @param {!Array.<shaka.extern.Stream>} textStreams
 * @return {?shaka.extern.Stream}
 * @private
 */
shaka.Player.prototype.chooseTextStream_ = function(textStreams) {
  const subset = shaka.util.StreamUtils.filterStreamsByLanguageAndRole(
      textStreams,
      this.currentTextLanguage_,
      this.currentTextRole_);

  return subset[0] || null;
};


/**
 * Chooses streams from the given Period and switches to them.
 * Called after a config change, a new text stream, a key status event, or an
 * explicit language change.
 *
 * @param {!shaka.extern.Period} period
 * @private
 */
shaka.Player.prototype.chooseStreamsAndSwitch_ = function(period) {
  goog.asserts.assert(this.config_, 'Must not be destroyed');

  // Because we're running this after a config change (manual language change),
  // a new text stream, or a key status event, and because switching to an
  // active stream is a no-op, it is always okay to clear the buffer here.
  const chosenVariant = this.chooseVariant_(period.variants);
  if (chosenVariant) {
    this.addVariantToSwitchHistory_(
        period, chosenVariant, /* fromAdaptation= */ true);
    this.switchVariant_(chosenVariant, /* clearBuffers */ true);
  }

  // Only switch text if we should be streaming text right now.
  const chosenText = this.chooseTextStream_(period.textStreams);
  if (chosenText && this.shouldStreamText_()) {
    this.addTextStreamToSwitchHistory_(
      period, chosenText, /* fromAdaptation= */ true);
    this.switchTextStream_(chosenText);
  }

  // Send an adaptation event so that the UI can show the new language/tracks.
  this.onAdaptation_();
};


/**
 * Callback from StreamingEngine, invoked when a period starts. This method
 * must always "succeed" so it may not throw an error. Any errors must be
 * routed to |onError|.
 *
 * @param {!shaka.extern.Period} period
 * @return {shaka.media.StreamingEngine.ChosenStreams}
 *    An object containing the chosen variant and text stream.
 * @private
 */
shaka.Player.prototype.onChooseStreams_ = function(period) {
  shaka.log.debug('onChooseStreams_', period);

  goog.asserts.assert(this.config_, 'Must not be destroyed');

  try {
    shaka.log.v2('onChooseStreams_, choosing variant from ', period.variants);
    shaka.log.v2('onChooseStreams_, choosing text from ', period.textStreams);

    const chosen = this.chooseStreams_(period);

    shaka.log.v2('onChooseStreams_, chose variant ', chosen.variant);
    shaka.log.v2('onChooseStreams_, chose text ', chosen.text);

    return chosen;
  } catch (e) {
    this.onError_(e);
    return {variant: null, text: null};
  }
};


/**
 * This is the internal logic for |onChooseStreams_|. This separation is done
 * to allow this implementation to throw errors without consequence.
 *
 * @param {shaka.extern.Period} period
 *    The period that we are selecting streams from.
 * @return {shaka.media.StreamingEngine.ChosenStreams}
 *    An object containing the chosen variant and text stream.
 * @private
 */
shaka.Player.prototype.chooseStreams_ = function(period) {
  // We are switching Periods, so the AbrManager will be disabled.  But if we
  // want to abr.enabled, we do not want to call AbrManager.enable before
  // canSwitch_ is called.
  this.switchingPeriods_ = true;
  this.abrManager_.disable();

  shaka.log.debug('Choosing new streams after period changed');

  let chosenVariant = this.chooseVariant_(period.variants);
  let chosenText = this.chooseTextStream_(period.textStreams);

  // Ignore deferred variant or text streams only if we are starting a new
  // period.  In this case, any deferred switches were from an older period, so
  // they do not apply.  We can still have deferred switches from the current
  // period in the case of an early call to select*Track while we are setting up
  // the first period.  This can happen with the 'streaming' event.
  if (this.deferredVariant_) {
    if (period.variants.includes(this.deferredVariant_)) {
      chosenVariant = this.deferredVariant_;
    }
    this.deferredVariant_ = null;
  }

  if (this.deferredTextStream_) {
    if (period.textStreams.includes(this.deferredTextStream_)) {
      chosenText = this.deferredTextStream_;
    }
    this.deferredTextStream_ = null;
  }

  if (chosenVariant) {
    this.addVariantToSwitchHistory_(
        period, chosenVariant, /* fromAdaptation= */ true);
  }

  if (chosenText) {
    this.addTextStreamToSwitchHistory_(
        period, chosenText, /* fromAdaptation= */ true);
  }

  // Check if we should show text (based on difference between audio and text
  // languages). Only check this during startup so we don't "pop-up" captions
  // mid playback.
  const startingUp = !this.streamingEngine_.getBufferingPeriod();
  const chosenAudio = chosenVariant ? chosenVariant.audio : null;
  if (startingUp && chosenAudio && chosenText) {
    if (this.shouldShowText_(chosenAudio, chosenText)) {
      this.setTextTrackVisibility(true);
      this.onTextTrackVisibility_();
    }
  }

  // Don't fire a tracks-changed event since we aren't inside the new Period
  // yet.
  // Don't initialize with a text stream unless we should be streaming text.
  if (this.shouldStreamText_()) {
    return {variant: chosenVariant, text: chosenText};
  } else {
    return {variant: chosenVariant, text: null};
  }
};


/**
 * Check if we should show text on screen automatically.
 *
 * The text should automatically be shown if the text is language-compatible
 * with the user's text language preference, but not compatible with the audio.
 *
 * For example:
 *   preferred | chosen | chosen |
 *   text      | text   | audio  | show
 *   -----------------------------------
 *   en-CA     | en     | jp     | true
 *   en        | en-US  | fr     | true
 *   fr-CA     | en-US  | jp     | false
 *   en-CA     | en-US  | en-US  | false
 *
 * @param {shaka.extern.Stream} audioStream
 * @param {shaka.extern.Stream} textStream
 * @return {boolean}
 * @private
 */
shaka.Player.prototype.shouldShowText_ = function(audioStream, textStream) {
  const areLanguageCompatible = shaka.util.LanguageUtils.areLanguageCompatible;
  const normalize = shaka.util.LanguageUtils.normalize;

  /** @type {string} */
  const preferredTextLocale = normalize(this.config_.preferredTextLanguage);
  /** @type {string} */
  const audioLocale = normalize(audioStream.language);
  /** @type {string} */
  const textLocale = normalize(textStream.language);

  return areLanguageCompatible(textLocale, preferredTextLocale) &&
         !areLanguageCompatible(audioLocale, textLocale);
};


/**
 * Callback from StreamingEngine, invoked when the period is set up.
 *
 * @private
 */
shaka.Player.prototype.canSwitch_ = function() {
  shaka.log.debug('canSwitch_');
  goog.asserts.assert(this.config_, 'Must not be destroyed');

  this.switchingPeriods_ = false;

  if (this.config_.abr.enabled) {
    this.abrManager_.enable();
  }

  // If we still have deferred switches, switch now.
  if (this.deferredVariant_) {
    this.streamingEngine_.switchVariant(
        this.deferredVariant_, this.deferredVariantClearBuffer_,
        this.deferredVariantClearBufferSafeMargin_);
    this.deferredVariant_ = null;
  }
  if (this.deferredTextStream_) {
    this.streamingEngine_.switchTextStream(this.deferredTextStream_);
    this.deferredTextStream_ = null;
  }
};


/**
 * Callback from StreamingEngine.
 *
 * @private
 */
shaka.Player.prototype.onManifestUpdate_ = function() {
  if (this.parser_ && this.parser_.update) {
    this.parser_.update();
  }
};


/**
 * Callback from StreamingEngine.
 *
 * @private
 */
shaka.Player.prototype.onSegmentAppended_ = function() {
  if (this.playhead_) {
    this.playhead_.onSegmentAppended();
  }
};


/**
 * Callback from AbrManager.
 *
 * @param {shaka.extern.Variant} variant
 * @param {boolean=} clearBuffer
 * @param {number=} safeMargin Optional amount of buffer (in seconds) to retain
 *   when clearing the buffer.
 *   Defaults to 0 if not provided. Ignored if clearBuffer is false.
 * @private
 */
shaka.Player.prototype.switch_ = function(
    variant, clearBuffer = false, safeMargin = 0) {
  shaka.log.debug('switch_');
  goog.asserts.assert(this.config_.abr.enabled,
      'AbrManager should not call switch while disabled!');
  goog.asserts.assert(!this.switchingPeriods_,
      'AbrManager should not call switch while transitioning between Periods!');
  goog.asserts.assert(this.manifest_, 'We need a manifest to switch variants.');

  const periodIndex = shaka.util.StreamUtils.findPeriodContainingVariant(
      this.manifest_, variant);
  const period = this.manifest_.periods[periodIndex];

  this.addVariantToSwitchHistory_(period, variant, /* fromAdaptation */ true);

  if (!this.streamingEngine_) {
    // There's no way to change it.
    return;
  }

  this.streamingEngine_.switchVariant(variant, clearBuffer, safeMargin);
  this.onAdaptation_();
};


/**
 * Dispatches an 'adaptation' event.
 * @private
 */
shaka.Player.prototype.onAdaptation_ = function() {
  // Delay the 'adaptation' event so that StreamingEngine has time to absorb
  // the changes before the user tries to query it.
  this.delayDispatchEvent_(new shaka.util.FakeEvent('adaptation'));
};


/**
 * Dispatches a 'trackschanged' event.
 * @private
 */
shaka.Player.prototype.onTracksChanged_ = function() {
  // Delay the 'trackschanged' event so StreamingEngine has time to absorb the
  // changes before the user tries to query it.
  this.delayDispatchEvent_(new shaka.util.FakeEvent('trackschanged'));
};


/**
 * Dispatches a 'variantchanged' event.
 * @private
 */
shaka.Player.prototype.onVariantChanged_ = function() {
  // Delay the 'trackschanged' event so StreamingEngine has time to absorb the
  // changes before the user tries to query it.
  this.delayDispatchEvent_(new shaka.util.FakeEvent('variantchanged'));
};


/**
 * Dispatches a 'textchanged' event.
 * @private
 */
shaka.Player.prototype.onTextChanged_ = function() {
  // Delay the 'textchanged' event so StreamingEngine time to absorb the
  // changes before the user tries to query it.
  this.delayDispatchEvent_(new shaka.util.FakeEvent('textchanged'));
};


/** @private */
shaka.Player.prototype.onTextTrackVisibility_ = function() {
  let event = new shaka.util.FakeEvent('texttrackvisibility');
  this.dispatchEvent(event);
};


/**
 * @param {!shaka.util.Error} error
 * @private
 */
shaka.Player.prototype.onError_ = function(error) {
  // Errors dispatched after destroy is called are irrelevant.
  if (this.destroyer_.destroyed()) {
    return;
  }

  goog.asserts.assert(error instanceof shaka.util.Error, 'Wrong error type!');

  let event = new shaka.util.FakeEvent('error', {'detail': error});
  this.dispatchEvent(event);
  if (event.defaultPrevented) {
    error.handled = true;
  }
};


/**
 * @param {!Event} event
 * @private
 */
shaka.Player.prototype.onEvent_ = function(event) {
  this.dispatchEvent(event);
};


/**
 * When we fire region events, we need to copy the information out of the region
 * to break the connection with the player's internal data. We do the copy here
 * because this is the transition point between the player and the app.
 *
 * @param {string} eventName
 * @param {shaka.extern.TimelineRegionInfo} region
 *
 * @private
 */
shaka.Player.prototype.onRegionEvent_ = function(eventName, region) {
  // Always make a copy to avoid exposing our internal data to the app.
  const clone = {
    schemeIdUri: region.schemeIdUri,
    value: region.value,
    startTime: region.startTime,
    endTime: region.endTime,
    id: region.id,
    eventElement: region.eventElement,
  };

  this.onEvent_(new shaka.util.FakeEvent(eventName, {detail: clone}));
};


/**
 * @param {!Event} event
 * @private
 */
shaka.Player.prototype.onVideoError_ = function(event) {
  if (!this.video_.error) return;

  let code = this.video_.error.code;
  if (code == 1 /* MEDIA_ERR_ABORTED */) {
    // Ignore this error code, which should only occur when navigating away or
    // deliberately stopping playback of HTTP content.
    return;
  }

  // Extra error information from MS Edge and IE11:
  let extended = this.video_.error.msExtendedCode;
  if (extended) {
    // Convert to unsigned:
    if (extended < 0) {
      extended += Math.pow(2, 32);
    }
    // Format as hex:
    extended = extended.toString(16);
  }

  // Extra error information from Chrome:
  let message = this.video_.error.message;

  this.onError_(new shaka.util.Error(
      shaka.util.Error.Severity.CRITICAL,
      shaka.util.Error.Category.MEDIA,
      shaka.util.Error.Code.VIDEO_ERROR,
      code, extended, message));
};


/**
 * @param {!Object.<string, string>} keyStatusMap A map of hex key IDs to
 *   statuses.
 * @private
 */
shaka.Player.prototype.onKeyStatus_ = function(keyStatusMap) {
  goog.asserts.assert(this.streamingEngine_, 'Should have been initialized.');
  const restrictedStatuses = shaka.Player.restrictedStatuses_;

  const period = this.getPresentationPeriod_();
  let tracksChanged = false;

  let keyIds = Object.keys(keyStatusMap);
  if (keyIds.length == 0) {
    shaka.log.warning(
        'Got a key status event without any key statuses, so we don\'t know ' +
        'the real key statuses. If we don\'t have all the keys, you\'ll need ' +
        'to set restrictions so we don\'t select those tracks.');
  }

  // If EME is using a synthetic key ID, the only key ID is '00' (a single 0
  // byte).  In this case, it is only used to report global success/failure.
  // See note about old platforms in: https://bit.ly/2tpez5Z
  let isGlobalStatus = keyIds.length == 1 && keyIds[0] == '00';

  if (isGlobalStatus) {
    shaka.log.warning(
        'Got a synthetic key status event, so we don\'t know the real key ' +
        'statuses. If we don\'t have all the keys, you\'ll need to set ' +
        'restrictions so we don\'t select those tracks.');
  }

  // Only filter tracks for keys if we have some key statuses to look at.
  if (keyIds.length) {
    period.variants.forEach(function(variant) {
      const streams = shaka.util.StreamUtils.getVariantStreams(variant);

      streams.forEach(function(stream) {
        let originalAllowed = variant.allowedByKeySystem;

        // Only update if we have a key ID for the stream.
        // If the key isn't present, then we don't have that key and the track
        // should be restricted.
        if (stream.keyId) {
          let keyStatus = keyStatusMap[isGlobalStatus ? '00' : stream.keyId];
          variant.allowedByKeySystem =
              !!keyStatus && !restrictedStatuses.includes(keyStatus);
        }

        if (originalAllowed != variant.allowedByKeySystem) {
          tracksChanged = true;
        }
      });  // streams.forEach
    });  // period.variants.forEach
  }  // if (keyIds.length)

  // TODO: Get StreamingEngine to track variants and create
  // getBufferingVariant()
  let activeAudio = this.streamingEngine_.getBufferingAudio();
  let activeVideo = this.streamingEngine_.getBufferingVideo();
  let activeVariant = shaka.util.StreamUtils.getVariantByStreams(
      activeAudio, activeVideo, period.variants);

  if (activeVariant && !activeVariant.allowedByKeySystem) {
    shaka.log.debug('Choosing new streams after key status changed');
    this.chooseStreamsAndSwitch_(period);
  }

  if (tracksChanged) {
    this.onTracksChanged_();
    this.chooseVariant_(period.variants);
  }
};


/**
 * Callback from DrmEngine
 * @param {string} keyId
 * @param {number} expiration
 * @private
 */
shaka.Player.prototype.onExpirationUpdated_ = function(keyId, expiration) {
  if (this.parser_ && this.parser_.onExpirationUpdated) {
    this.parser_.onExpirationUpdated(keyId, expiration);
  }

  let event = new shaka.util.FakeEvent('expirationupdated');
  this.dispatchEvent(event);
};

/**
 * @return {boolean} true if we should stream text right now.
 * @private
 */
shaka.Player.prototype.shouldStreamText_ = function() {
  return this.config_.streaming.alwaysStreamText || this.isTextTrackVisible();
};


/**
 * Applies playRangeStart and playRangeEnd to the given timeline. This will
 * only affect non-live content.
 *
 * @param {shaka.media.PresentationTimeline} timeline
 * @param {number} playRangeStart
 * @param {number} playRangeEnd
 *
 * @private
 */
shaka.Player.applyPlayRange_ = function(timeline,
                                        playRangeStart,
                                        playRangeEnd) {
  if (playRangeStart > 0) {
    if (timeline.isLive()) {
      shaka.log.warning(
          '|playRangeStart| has been configured for live content. ' +
          'Ignoring the setting.');
    } else {
      timeline.setUserSeekStart(playRangeStart);
    }
  }

  // If the playback has been configured to end before the end of the
  // presentation, update the duration unless it's live content.
  const fullDuration = timeline.getDuration();
  if (playRangeEnd < fullDuration) {
    if (timeline.isLive()) {
      shaka.log.warning(
          '|playRangeEnd| has been configured for live content. ' +
          'Ignoring the setting.');
    } else {
      timeline.setDuration(playRangeEnd);
    }
  }
};


/**
 * Checks the given variants and if they are all restricted, throw an
 * appropriate exception.
 *
 * @param {!Array.<shaka.extern.Variant>} variants
 * @private
 */
shaka.Player.prototype.checkRestrictedVariants_ = function(variants) {
  const restrictedStatuses = shaka.Player.restrictedStatuses_;
  const keyStatusMap = this.drmEngine_ ? this.drmEngine_.getKeyStatuses() : {};
  const keyIds = Object.keys(keyStatusMap);
  const isGlobalStatus = keyIds.length && keyIds[0] == '00';

  let hasPlayable = false;
  let hasAppRestrict = false;
  let missingKeys = [];
  let badKeyStatuses = [];

  for (let variant of variants) {
    // TODO: Combine with onKeyStatus_.
    let streams = [];
    if (variant.audio) streams.push(variant.audio);
    if (variant.video) streams.push(variant.video);

    for (let stream of streams) {
      if (stream.keyId) {
        let keyStatus = keyStatusMap[isGlobalStatus ? '00' : stream.keyId];
        if (!keyStatus) {
          if (!missingKeys.includes(stream.keyId)) {
            missingKeys.push(stream.keyId);
          }
        } else if (restrictedStatuses.includes(keyStatus)) {
          if (!badKeyStatuses.includes(keyStatus)) {
            badKeyStatuses.push(keyStatus);
          }
        }
      }
    }

    if (!variant.allowedByApplication) {
      hasAppRestrict = true;
    } else if (variant.allowedByKeySystem) {
      hasPlayable = true;
    }
  }

  if (!hasPlayable) {
    /** @type {shaka.extern.RestrictionInfo} */
    let data = {
      hasAppRestrictions: hasAppRestrict,
      missingKeys: missingKeys,
      restrictedKeyStatuses: badKeyStatuses,
    };
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.RESTRICTIONS_CANNOT_BE_MET,
        data);
  }
};


/**
 * Fire an event, but wait a little bit so that the immediate execution can
 * complete before the event is handled.
 *
 * @param {!shaka.util.FakeEvent} event
 * @private
 */
shaka.Player.prototype.delayDispatchEvent_ = async function(event) {
  // Wait until the next interpreter cycle.
  await Promise.resolve();

  // Only dispatch the event if we are still alive.
  if (!this.destroyer_.destroyed()) {
    this.dispatchEvent(event);
  }
};

/**
 * Get the normalized languages for a group of streams. If a stream is |null|,
 * it means that there is a variant but no audio stream and the language should
 * be "und".
 *
 * @param {!Array.<?shaka.extern.Stream>} streams
 * @return {!Set.<string>}
 * @private
 */
shaka.Player.getLanguagesFrom_ = function(streams) {
  const languages = new Set();

  for (const stream of streams) {
    if (stream && stream.language) {
      languages.add(shaka.util.LanguageUtils.normalize(stream.language));
    } else {
      languages.add('und');
    }
  }

  return languages;
};


/**
 * Get all permutations of normalized languages and role for a group of streams.
 * If a stream is |null|, it means that there is a variant but no audio stream
 * and the language should be "und".
 *
 * @param {!Array.<?shaka.extern.Stream>} streams
 * @return {!Array.<shaka.extern.LanguageRole>}
 * @private
 */
shaka.Player.getLanguageAndRolesFrom_ = function(streams) {
  /** @type {!Map.<string, !Set>} */
  const languageToRoles = new Map();

  // We must have an empty role so that we will still get a language-role entry.
  const noRoles = [''];

  for (const stream of streams) {
    let language = 'und';
    let roles = noRoles;

    if (stream && stream.language) {
      language = shaka.util.LanguageUtils.normalize(stream.language);
    }

    if (stream && stream.roles.length) {
      roles = stream.roles;
    }

    if (!languageToRoles.has(language)) {
      languageToRoles.set(language, new Set());
    }

    for (const role of roles) {
      languageToRoles.get(language).add(role);
    }
  }

  // Flatten our map to an array of language-role pairs.
  const pairings = [];
  languageToRoles.forEach((roles, language) => {
    for (const role of roles) {
      pairings.push({
        language: language,
        role: role,
      });
    }
  });
  return pairings;
};


/**
 * Get the variants that the user can select. The variants will be based on
 * the period that the playhead is in and what variants are playable.
 *
 * @return {!Array.<shaka.extern.Variant>}
 * @private
 */
shaka.Player.prototype.getSelectableVariants_ = function() {
  // Use the period that is currently playing, allowing the change to affect
  // the "now".
  const currentPeriod = this.getPresentationPeriod_();

  // If we have been called before we load content or after we have unloaded
  // content, then we should return no variants.
  if (currentPeriod == null) { return []; }

  this.assertCorrectActiveStreams_();

  return currentPeriod.variants.filter((variant) => {
    return shaka.util.StreamUtils.isPlayable(variant);
  });
};


/**
 * Get the text streams that the user can select. The streams will be based on
 * the period that the playhead is in and what streams have finished loading.
 *
 * @return {!Array.<shaka.extern.Stream>}
 * @private
 */
shaka.Player.prototype.getSelectableText_ = function() {
  // Use the period that is currently playing, allowing the change to affect
  // the "now".
  const currentPeriod = this.getPresentationPeriod_();

  // If we have been called before we load content or after we have unloaded
  // content, then we should return no streams.
  if (currentPeriod == null) { return []; }

  this.assertCorrectActiveStreams_();

  // Don't show return streams that are still loading.
  return currentPeriod.textStreams.filter((stream) => {
    return !this.loadingTextStreams_.has(stream);
  });
};

/**
 * Get the period that is on the screen. This will return |null| if nothing
 * is loaded.
 *
 * @return {?shaka.extern.Period}
 * @private
 */
shaka.Player.prototype.getPresentationPeriod_ = function() {
  // We need both a manifest and the playhead in order to determine which period
  // we are playing.
  if (this.manifest_ == null) { return null; }
  if (this.playhead_ == null) { return null; }

  const presentationTime = this.playhead_.getTime();

  let lastPeriod = null;

  // Periods are ordered by |startTime|. If we always keep the last period that
  // started before our presentation time, it means we will have the best guess
  // at which period we are presenting.
  for (const period of this.manifest_.periods) {
    if (period.startTime <= presentationTime) {
      lastPeriod = period;
    }
  }

  return lastPeriod;
};


/**
 * Get the variant that we are currently presenting to the user. If we are not
 * showing anything, then we will return |null|.
 *
 * @return {?shaka.extern.Variant}
 * @private
 */
shaka.Player.prototype.getPresentationVariant_ = function() {
  const currentPeriod = this.getPresentationPeriod_();

  return currentPeriod ?
         this.activeStreams_.getVariant(currentPeriod) :
         null;
};


/**
 * Get the text stream that we are either currently presenting to the user or
 * will be presenting will captions are enabled. If we have no text to display,
 * this will return |null|.
 *
 * @return {?shaka.extern.Stream}
 * @private
 */
shaka.Player.prototype.getPresentationText_ = function() {
  const currentPeriod = this.getPresentationPeriod_();

  // Can't have a text stream when there is no period.
  if (currentPeriod == null) { return null; }

  // This is a workaround for the demo page to be able to display the list of
  // text tracks. If no text track is currently active, pick  the one that's\
  // going to be streamed when captions are enabled and mark it as active.
  if (!this.activeStreams_.getText(currentPeriod)) {
    const textStreams = shaka.util.StreamUtils.filterStreamsByLanguageAndRole(
        currentPeriod.textStreams,
        this.currentTextLanguage_,
        this.currentTextRole_);

    if (textStreams.length) {
      this.activeStreams_.useText(currentPeriod, textStreams[0]);
    }
  }

  return this.activeStreams_.getText(currentPeriod);
};


/**
 * Check if we are buffered to the end of the presentation.
 *
 * @return {boolean}
 * @private
 */
shaka.Player.prototype.isBufferedToEnd_ = function() {
  goog.asserts.assert(
      this.video_,
      'We need a video element to get buffering information');
  goog.asserts.assert(
      this.mediaSourceEngine_,
      'We need a media source engine to get buffering information');
  goog.asserts.assert(
      this.manifest_,
      'We need a manifest to get buffering information');

  // This is a strong guarantee that we are buffered to the end, because it
  // means the playhead is already at that end.
  if (this.video_.ended) {
    return true;
  }

  // This means that MediaSource has buffered the final segment in all
  // SourceBuffers and is no longer accepting additional segments.
  if (this.mediaSourceEngine_.ended()) {
    return true;
  }

  // Live streams are "buffered to the end" when they have buffered to the live
  // edge or beyond (into the region covered by the presentation delay).
  if (this.manifest_.presentationTimeline.isLive()) {
    const liveEdge =
        this.manifest_.presentationTimeline.getSegmentAvailabilityEnd();
    const bufferEnd =
        shaka.media.TimeRangesUtils.bufferEnd(this.video_.buffered);

    if (bufferEnd >= liveEdge) {
      return true;
    }
  }

  return false;
};