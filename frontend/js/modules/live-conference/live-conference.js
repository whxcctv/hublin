'use strict';

angular.module('op.live-conference', [
  'op.liveconference-templates',
  'op.easyrtc',
  'op.websocket',
  'op.notification',
  'meetings.authentication',
  'meetings.session',
  'meetings.conference',
  'meetings.invitation',
  'meetings.report',
  'meetings.wizard'
])
.constant('MAX_RECONNECT_TIMEOUT', 30000)
.constant('EVENTS', {
    beforeunload: 'beforeunload',
    conferenceleft: 'conferenceleft'
})
.controller('conferenceController', [
  '$scope',
  '$log',
  '$stateParams',
  'session',
  'conference',
  'ioConnectionManager',
  '$window',
  'deviceDetector',
  'eventCallbackRegistry',
  'EVENTS',
  '$state',
  'configurationService',
  'userService',
  function($scope, $log, $stateParams, session, conference, ioConnectionManager, $window, deviceDetector, eventCallbackRegistry,
           EVENTS, $state, configurationService, userService) {
    session.ready.then(function() {
      var wsServerURI = '';
      $state.go('app.conference');

      if (conference.configuration && conference.configuration.hosts && conference.configuration.hosts.length) {
        conference.configuration.hosts.forEach(function(host) {
          if ('ws' === host.type) {
            wsServerURI = host.url;
          }
        });
      }

      $scope.wsServerURI = wsServerURI;
      $log.info('Using \'%s\' as the websocket backend.', wsServerURI);

      $log.debug('Connecting to websocket at address \'%s\' for user %s.', $scope.wsServerURI, session.user);
      ioConnectionManager.connect($scope.wsServerURI);
    });

    var shouldAutostart = $stateParams.autostart && $stateParams.displayName;

    $scope.conference = conference;
    $scope.process = {
      step: shouldAutostart ? 'conference' : 'configuration'
    };

    $scope.init = function() {
      session.initialized.then(function() {
        //$scope.process.step = 'conference';
      });

      session.goodbye.then(function() {
        //$scope.process.step = 'goodbye';
      });

      // MEET-363
      // Firefox doesn't allow our custom message to be displayed. It only displays a
      // generic message and the user doesn't understand why this popup is nagging him.
      // To not confuse him/her, we decided to not display the popup on Firefox.
      //
      // More info:
      //  - https://bugzilla.mozilla.org/show_bug.cgi?id=641509
      //  - https://bugzilla.mozilla.org/show_bug.cgi?id=588292
      //
      if (!deviceDetector.raw.browser.firefox) {
        angular.element($window).on(EVENTS.beforeunload, function() {
          if ($scope.process.step === 'conference') {
            var messages,
                callbacks = eventCallbackRegistry[EVENTS.beforeunload];

            if (callbacks && callbacks.length) {
              messages = callbacks.map(function(callback) {
                return callback();
              }).filter(Boolean);
            }

            if (messages && messages.length) {
              return messages.join('\n');
            }
          }
        });
      }
    };

    $scope.init();

    if (shouldAutostart) {
      var displayName = userService.getDisplayName();

      $log.info('Automatically joining conference ', $stateParams.conferenceId, ' with displayName ', displayName);

      configurationService
        .configure({ displayName: displayName })
        .then(session.setConfigured.bind(session, true), session.setConfigured.bind(session, false));
    }
  }
])
.factory('eventCallbackRegistry', function() {
    return {};
  })
.factory('eventCallbackService', ['eventCallbackRegistry', function(registry) {
    return {
      on: function(event, callback) {
        if (!angular.isFunction(callback)) {
          throw new Error('The callback parameter must be a function!');
        }

        if (!angular.isArray(registry[event])) {
          registry[event] = [];
        }

        registry[event].push(callback);
      },
      off: function(event, callback) {
        var callbacks = registry[event];

        if (callbacks && callbacks.length) {
          registry[event] = callbacks.filter(function(element) {
            return callback !== element;
          });
        }
      }
    };
  }])
.directive('liveConference', [
  '$log',
  '$timeout',
  '$interval',
  'session',
  'conferenceAPI',
  'webRTCService',
  'currentConferenceState',
  'LOCAL_VIDEO_ID',
  'REMOTE_VIDEO_IDS',
  function($log, $timeout, $interval, session, conferenceAPI, webRTCService, currentConferenceState, LOCAL_VIDEO_ID, REMOTE_VIDEO_IDS) {
    function controller($scope) {
      $scope.conference = session.conference;
      $scope.conferenceState = currentConferenceState;
      $scope.conferenceId = $scope.conference._id;
      $scope.reportedAttendee = null;

      $scope.$on('$locationChangeStart', function() {
        webRTCService.leaveRoom($scope.conferenceState.conference);
      });

      $scope.showInvitation = function() {
        $('#invite').modal('show');
      };

      $scope.showReport = function(attendee) {
        $scope.reportedAttendee = attendee;
        $('#reportModal').modal('show');
      };

      $scope.onLeave = function() {
        $log.debug('Leaving the conference');
        webRTCService.leaveRoom($scope.conferenceState.conference);
        session.leave();
      };

      $scope.invite = function(user) {
        $log.debug('Invite user', user);
        conferenceAPI.invite($scope.conferenceId, user._id).then(
          function(response) {
            $log.info('User has been invited', response.data);
          },
          function(error) {
            $log.error('Error while inviting user', error.data);
          }
        );
      };

      $scope.$on('conferencestate:attendees:push', function() {
        conferenceAPI.get($scope.conferenceId).then(function(response) {
          $scope.conferenceState.conference = response.data;
        }, function(err) {
          $log.error('Cannot get conference', $scope.conferenceId, err);
        });

        if ($scope.conferenceState.attendees.length === 2) {
          var video = $('#' + REMOTE_VIDEO_IDS[0]);
          var interval = $interval(function() {
            if (video[0].videoWidth) {
              $scope.conferenceState.updateLocalVideoIdToIndex(1);
              $scope.$apply();
              $interval.cancel(interval);
            }
          }, 100, 30, false);
        }
      });

      $scope.$on('conferencestate:attendees:remove', function(event, data) {
        conferenceAPI.get($scope.conferenceId).then(function(response) {
          $scope.conferenceState.conference = response.data;
        }, function(err) {
          $log.error('Cannot get conference', $scope.conferenceId, err);
        });

        if (data && data.videoIds === $scope.conferenceState.localVideoId) {
          $log.debug('Stream first attendee to main canvas');
          $scope.conferenceState.updateLocalVideoIdToIndex(0);
        }
      });

      // We must wait for the directive holding the template containing videoIds
      // to be displayed in the browser before using easyRTC.
      var unregisterLocalVideoWatch = $scope.$watch(function() {
        return angular.element('#' + LOCAL_VIDEO_ID)[0];
      }, function(video) {
        if (video) {
          webRTCService.connect($scope.conferenceState);
          unregisterLocalVideoWatch();
        }
      });
    }
    return {
      restrict: 'A',
      controller: controller
    };
  }
])

  .directive('streamVideo', ['currentConferenceState', function(currentConferenceState) {
    return {
      restrict: 'E',
      link: function(scope, element) {
        currentConferenceState.videoElements.forEach(function(video) { element.append(video); });
      }
    };
  }])

.directive('liveConferenceAutoReconnect', ['webRTCService', 'MAX_RECONNECT_TIMEOUT', '$log', '$timeout',
function(webRTCService, MAX_RECONNECT_TIMEOUT, $log, $timeout) {
  function link($scope) {
    webRTCService.addDisconnectCallback(function() {
      function connect() {
        webRTCService.connect($scope.conferenceState, function(err) {
          if (err) {
            reconnectCount++;
            reconnect();
          } else {
            reconnectCount = 0;
            $('#disconnectModal').modal('hide');
          }
        });
      }

      function reconnect() {
        var delay = 1000 << reconnectCount; // jshint ignore:line

        if (delay >= MAX_RECONNECT_TIMEOUT) {
          $scope.toolong = true;
          delay = MAX_RECONNECT_TIMEOUT;
        }
        $log.info('Reconnecting in ' + delay + 'ms');
        $timeout(connect, delay);
      }

      var reconnectCount = 0;
      $scope.toolong = false;
      $('#disconnectModal').modal('show');
      reconnect();
    });
  }

  return {
    retrict: 'A',
    require: 'liveConference',
    link: link
  };

}])
.directive('liveConferenceNotification', ['$log', 'session', 'notificationFactory', 'livenotification',
  function($log, session, notificationFactory, livenotification) {
    return {
      restrict: 'E',
      link: function(scope, element, attrs) {
        function liveNotificationHandler(msg) {
          $log.debug('Got a live notification', msg);
          if (msg.user._id !== session.user._id) {
            notificationFactory.weakInfo('Conference updated!', msg.message);
          }
        }

        var socketIORoom = livenotification('/conferences', attrs.conferenceId)
          .on('notification', liveNotificationHandler);

        scope.$on('$destroy', function() {
          socketIORoom.removeListener('notification', liveNotificationHandler);
        });
      }
    };
  }
]).directive('disconnectDialog', ['$window', function($window) {
  return {
    restrict: 'E',
    replace: true,
    templateUrl: '/views/live-conference/partials/disconnect-dialog.html',
    link: function(scope) {
      scope.reloadPage = function() {
        $window.location.reload();
      };
    }
  };
}])
.directive('goodbyePageReminders', ['eventCallbackRegistry', function(eventCallbackRegistry) {
  return {
    restrict: 'E',
    replace: true,
    templateUrl: '/views/live-conference/partials/reminders.html',
    link: function(scope) {
      var callbacks = eventCallbackRegistry.conferenceleft;

      if (callbacks && callbacks.length) {
        scope.conferenceLeftActions = callbacks.map(function(callback) {
          return callback();
        }).filter(function(action) {
          return action && action.buttons;
        });
      }
    }
  };
}])
.controller('dropDownController', ['$scope', function($scope) {
  var buttonIndex = 0;
  $scope.action.buttons.forEach(function(button, index) {
    if (button.default) {
      buttonIndex = index;
    }
  });

  $scope.setButton = function(n) {
    buttonIndex = n;
    return true;
  };
  $scope.getButton = function() {
    return $scope.action.buttons[buttonIndex];
  };
}]);
