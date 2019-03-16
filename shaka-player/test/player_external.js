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

describe('Player', () => {
  const Util = shaka.test.Util;
  const Feature = shakaAssets.Feature;

  /** @type {!jasmine.Spy} */
  let onErrorSpy;

  /** @type {shaka.extern.SupportType} */
  let support;
  /** @type {!HTMLVideoElement} */
  let video;
  /** @type {shaka.Player} */
  let player;
  /** @type {shaka.util.EventManager} */
  let eventManager;

  let compiledShaka;

  beforeAll(async () => {
    video = /** @type {!HTMLVideoElement} */ (document.createElement('video'));
    video.width = 600;
    video.height = 400;
    video.muted = true;
    document.body.appendChild(video);

    /** @type {!shaka.util.PublicPromise} */
    const loaded = new shaka.util.PublicPromise();
    if (getClientArg('uncompiled')) {
      // For debugging purposes, use the uncompiled library.
      compiledShaka = shaka;
      loaded.resolve();
    } else {
      // Load the compiled library as a module.
      // All tests in this suite will use the compiled library.
      require(['/base/dist/shaka-player.ui.js'], (shakaModule) => {
        compiledShaka = shakaModule;
        loaded.resolve();
      });
    }

    await loaded;
    support = await compiledShaka.Player.probeSupport();
  });

  beforeEach(() => {
    player = new compiledShaka.Player(video);

    // Grab event manager from the uncompiled library:
    eventManager = new shaka.util.EventManager();

    onErrorSpy = jasmine.createSpy('onError');
    onErrorSpy.and.callFake((event) => fail(event.detail));
    eventManager.listen(player, 'error', Util.spyFunc(onErrorSpy));
  });

  afterEach(async () => {
    eventManager.release();

    await player.destroy();

    // Work-around: allow the Tizen media pipeline to cool down.
    // Without this, Tizen's pipeline seems to hang in subsequent tests.
    // TODO: file a bug on Tizen
    await Util.delay(0.1);
  });

  afterAll(() => {
    document.body.removeChild(video);
  });

  describe('plays', () => {
    function createAssetTest(asset) {
      if (asset.disabled) return;

      let testName =
          asset.source + ' / ' + asset.name + ' : ' + asset.manifestUri;

      let wit = asset.focus ? fit : it;
      wit(testName, async () => {
        if (asset.drm.length &&
            !asset.drm.some((keySystem) => support.drm[keySystem])) {
          pending('None of the required key systems are supported.');
        }

        if (asset.features) {
          let mimeTypes = [];
          if (asset.features.includes(Feature.WEBM)) {
            mimeTypes.push('video/webm');
          }
          if (asset.features.includes(Feature.MP4)) {
            mimeTypes.push('video/mp4');
          }
          if (!mimeTypes.some((type) => support.media[type])) {
            pending('None of the required MIME types are supported.');
          }
        }

        // Make sure we are playing the lowest res available to avoid test flake
        // based on network issues.  Note that disabling ABR and setting a low
        // abr.defaultBandwidthEstimate would not be sufficient, because it
        // would only affect the choice of track on the first period.  When we
        // cross a period boundary, the default bandwidth estimate will no
        // longer be in effect, and AbrManager may choose higher res tracks for
        // the new period.  Using abr.restrictions.maxHeight will let us force
        // AbrManager to the lowest resolution, which is its fallback when these
        // soft restrictions cannot be met.
        player.configure('abr.restrictions.maxHeight', 1);

        // Make sure that live streams are synced against a good clock.
        player.configure('manifest.dash.clockSyncUri',
            'https://shaka-player-demo.appspot.com/time.txt');

        // Make sure we don't get stuck on gaps that only appear in some
        // browsers (Safari, Firefox).
        // TODO(https://github.com/google/shaka-player/issues/1702):
        // Is this necessary because of a bug in Shaka Player?
        player.configure('streaming.jumpLargeGaps', true);

        // Configure DRM for this asset.
        if (asset.licenseServers) {
          player.configure('drm.servers', asset.licenseServers);
        }
        if (asset.drmCallback) {
          player.configure('manifest.dash.customScheme', asset.drmCallback);
        }
        if (asset.clearKeys) {
          player.configure('drm.clearKeys', asset.clearKeys);
        }

        // Configure networking for this asset.
        const networkingEngine = player.getNetworkingEngine();
        if (asset.licenseRequestHeaders) {
          const headers = asset.licenseRequestHeaders;
          networkingEngine.registerRequestFilter((requestType, request) => {
            addLicenseRequestHeaders(headers, requestType, request);
          });
        }
        if (asset.requestFilter) {
          networkingEngine.registerRequestFilter(asset.requestFilter);
        }
        if (asset.responseFilter) {
          networkingEngine.registerResponseFilter(asset.responseFilter);
        }

        // Add any extra configuration for this asset.
        if (asset.extraConfig) {
          player.configure(asset.extraConfig);
        }

        await player.load(asset.manifestUri);
        if (asset.features) {
          const isLive = asset.features.includes(Feature.LIVE);
          expect(player.isLive()).toEqual(isLive);
        }
        video.play();

        // Wait for the video to start playback.  If it takes longer than 20
        // seconds, fail the test.
        await waitForMovementOrFailOnTimeout(video, 20);

        // Play for 30 seconds, but stop early if the video ends.
        await waitForEndOrTimeout(video, 30);

        if (video.ended) {
          checkEndedTime();
        } else {
          // Expect that in 30 seconds of playback, we go through at least 20
          // seconds of content.  This allows for some buffering or network
          // flake.
          expect(video.currentTime).toBeGreaterThan(20);

          // Since video.ended is false, we expect the current time to be before
          // the video duration.
          expect(video.currentTime).toBeLessThan(video.duration);

          if (!player.isLive()) {
            // Seek close to the end and play the rest of the content.
            video.currentTime = video.duration - 15;

            // Wait for the video to start playback again after seeking.  If it
            // takes longer than 20 seconds, fail the test.
            await waitForMovementOrFailOnTimeout(video, 20);

            // Play for 30 seconds, but stop early if the video ends.
            await waitForEndOrTimeout(video, 30);

            // By now, ended should be true.
            expect(video.ended).toBe(true);
            checkEndedTime();
          }
        }
      });  // actual test
    }  // createAssetTest

    // The user can run tests on a specific manifest URI that is not in the
    // asset list.
    const testCustomAsset = getClientArg('testCustomAsset');
    if (testCustomAsset) {
      // Construct an "asset" structure to reuse the test logic above.
      /** @type {Object} */
      const licenseServers = getClientArg('testCustomLicenseServer');
      const keySystems = Object.keys(licenseServers || {});
      const asset = {
        source: 'command line',
        name: 'custom',
        manifestUri: testCustomAsset,
        focus: true,
        licenseServers: licenseServers,
        drm: keySystems,
      };
      createAssetTest(asset);
    } else {
      // No custom assets? Create a test for each asset in the demo asset list.
      shakaAssets.testAssets.forEach(createAssetTest);
    }
  });

  /**
   * Wait for the video playhead to move forward by some meaningful delta.
   * If this happens before |timeout| seconds pass, the Promise is resolved.
   * Otherwise, the Promise is rejected.
   *
   * @param {!HTMLMediaElement} target
   * @param {number} timeout in seconds, after which the Promise fails
   * @return {!Promise}
   */
  function waitForMovementOrFailOnTimeout(target, timeout) {
    const curEventManager = eventManager;
    const timeGoal = target.currentTime + 1;
    let goalMet = false;
    const startTime = Date.now();
    shaka.log.info('Waiting for movement from', target.currentTime,
                   'to', timeGoal);

    return new Promise((resolve, reject) => {
      curEventManager.listen(target, 'timeupdate', () => {
        if (target.currentTime >= timeGoal) {
          goalMet = true;
          const endTime = Date.now();
          const seconds = ((endTime - startTime) / 1000).toFixed(2);
          shaka.log.info('Movement goal met after ' + seconds + ' seconds');

          curEventManager.unlisten(target, 'timeupdate');
          resolve();
        }
      });

      Util.delay(timeout).then(() => {
        // This check is only necessary to supress the error log.  It's fine to
        // unlisten twice or to reject after resolve.  Neither of those actions
        // matter.  But the error log can be confusing during debugging if we
        // have already met the movement goal.
        if (!goalMet) {
          shaka.log.error('Timeout waiting for playback.',
                          'current time', target.currentTime,
                          'ready state', target.readyState,
                          'playback rate', target.playbackRate,
                          'paused', target.paused,
                          'buffered', JSON.stringify(player.getBufferedInfo()));

          curEventManager.unlisten(target, 'timeupdate');
          reject(new Error('Timeout while waiting for playback!'));
        }
      });
    });
  }

  /**
   * Wait for the video to end or for |timeout| seconds to pass, whichever
   * occurs first.  The Promise is resolved when either of these happens.
   *
   * @param {!HTMLMediaElement} target
   * @param {number} timeout in seconds, after which the Promise succeeds
   * @return {!Promise}
   */
  function waitForEndOrTimeout(target, timeout) {
    const curEventManager = eventManager;

    return new Promise((resolve, reject) => {
      const callback = () => {
        curEventManager.unlisten(target, 'ended');
        resolve();
      };

      // Whichever happens first resolves the Promise.
      curEventManager.listen(target, 'ended', callback);
      Util.delay(timeout).then(callback);
    });
  }

  /**
   * Check the video time for videos that we expect to have ended.
   */
  function checkEndedTime() {
    if (video.currentTime >= video.duration) {
      // On some platforms, currentTime surpasses duration by more than 0.1s.
      // For the purposes of this test, this is fine, so don't set any precise
      // expectations on currentTime if it's larger.
    } else {
      // On some platforms, currentTime is less than duration, but it should be
      // close.
      expect(video.currentTime).toBeCloseTo(
          video.duration, 1 /* decimal place */);
    }
  }

  /**
   * @param {!Object.<string, string>} headers
   * @param {shaka.net.NetworkingEngine.RequestType} requestType
   * @param {shaka.extern.Request} request
   */
  function addLicenseRequestHeaders(headers, requestType, request) {
    const RequestType = compiledShaka.net.NetworkingEngine.RequestType;
    if (requestType != RequestType.LICENSE) return;

    // Add these to the existing headers.  Do not clobber them!
    // For PlayReady, there will already be headers in the request.
    for (let k in headers) {
      request.headers[k] = headers[k];
    }
  }
});