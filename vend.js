'use strict';

var _ = require('underscore');
var moment = require('moment');
var Promise = require('bluebird');

var request = require('request-promise');
//request.debug = true;

var log = require('winston');
log.remove(log.transports.Console);
log.add(log.transports.Console, {colorize: true, timestamp: false, level: 'debug'});

function RateLimitingError(e) {
  return e.statusCode == 429;
}

function AuthNError(e) {
  return e.statusCode == 401;
}

function AuthZError(e) {
  return e.statusCode == 403;
}

function ClientError(e) {
  return e.statusCode >= 400 && e.statusCode < 500;
}

var successHandler = function(response) {
  if(_.isArray(response)) {
    console.log('response is an array');
  }
  else if(_.isObject(response)) {
    console.log('response is an object');
  }
  else if(_.isString(response)) {
    console.log('response is a string');
    try{
      var responseObject = JSON.parse(response);
      //console.log(responseObject);
      return Promise.resolve(responseObject);
    }
    catch(error){
      console.error('caught an error: ', error);
      throw error;
    }
  }
  else {
    console.log(response);
  }
};

/**
 * TODO: Should we reuse the following library instead of rolling our own implementation here?
 *       https://github.com/you21979/node-limit-request-promise
 *
 * @param bodyObject
 * @param connectionInfo - contains tokens and domainPrefix
 * @param retryCounter
 * @param callback
 * @returns {*|Parse.Promise}
 */
var retryWhenRateLimited = function(bodyObject, args, connectionInfo, callback, retryCounter) {
  if(retryCounter<3) {
    var retryAfter = 5*60*1000; // by default Vend will never block for more than 5 minutes
    retryAfter = Math.max(moment(bodyObject['retry-after']).diff(moment()), 0);
    //retryAfter = 5000; // for sanity testing counter increments quickly
    console.log('retry after: ' + retryAfter + ' ms');

    return Promise.delay(retryAfter)
      .then(function() {
        console.log(retryAfter + ' ms have passed...');
        return callback(args, connectionInfo, ++retryCounter);
      });
  }
};

var retryWhenAuthNFails = function(args, connectionInfo, callback, retryCounter) {
  if(retryCounter<3) {
    if ( !(connectionInfo.vendTokenService &&
           connectionInfo.vendClientId &&
           connectionInfo.vendClientSecret &&
           connectionInfo.refreshToken) )
    {
      return Promise.reject('missing required arguments for retryWhenAuthNFails()');
      // throw e; // TODO: throw unknown errors but reject well known errors?
    }

    console.log('try to fetch a new access token');
    return refreshAccessToken( //TODO: validate connectionInfo before using it for retries?
      connectionInfo.vendTokenService,
      connectionInfo.vendClientId,
      connectionInfo.vendClientSecret,
      connectionInfo.refreshToken,
      connectionInfo.domainPrefix
    )
      .then(function(oauthInfo) {
        console.log('update connectionInfo w/ new token before using it again');
        if (oauthInfo.access_token) {
          console.log('received new access_token: ' + oauthInfo.access_token);
          connectionInfo.accessToken = oauthInfo.access_token;
        }
        if (oauthInfo.refresh_token) {
          console.log('received new refresh_token: ' + oauthInfo.refresh_token);
          connectionInfo.refreshToken = oauthInfo.refresh_token;
        }

        console.log('retrying with new accessToken: ' + connectionInfo.accessToken);
        return callback(args, connectionInfo, ++retryCounter);
      });
  }
};

var sendRequest = function(options, args, connectionInfo, callback, retryCounter) {
  return request(options)
    .then(successHandler)
    .catch(RateLimitingError, function(e) {
      console.log('A RateLimitingError error like "429 Too Many Requests" happened: \n'
          + 'statusCode: ' + e.statusCode + '\n'
          + 'body: ' + e.response.body + '\n'
        //+ JSON.stringify(e.response.headers,null,2)
      );

      var bodyObject = JSON.parse(e.response.body);
      console.log(bodyObject['retry-after']);
      console.log(
        moment(bodyObject['retry-after']).format('dddd, MMMM Do YYYY, h:mm:ss a ZZ')
      );
      /*successHandler(e.response.body)
        .then(function(bodyObject){
          console.log(bodyObject['retry-after']);
          console.log(
            moment(bodyObject['retry-after']).format('dddd, MMMM Do YYYY, h:mm:ss a ZZ')
          );
        });*/
      return retryWhenRateLimited(bodyObject, args, connectionInfo, callback, retryCounter);
      // TODO: how should a catch-block respond if there is a problem within the retry?
    })
    .catch(AuthNError, function(e) {
      console.log('An AuthNError happened: \n'
          + 'statusCode: ' + e.statusCode + '\n'
          + 'body: ' + e.response.body + '\n'
        /*+ JSON.stringify(e.response.headers,null,2)
         + JSON.stringify(e,null,2)*/
      );
      return retryWhenAuthNFails(args, connectionInfo, callback, retryCounter);
      // TODO: how to prevent a throw or rejection from also stepping thru the other catch-blocks?
    })
    .catch(ClientError, function(e) {
      console.log('A ClientError happened: \n'
          + e.statusCode + ' ' + e.response.body + '\n'
        /*+ JSON.stringify(e.response.headers,null,2)
         + JSON.stringify(e,null,2)*/
      );

      // TODO: add retry logic

      return Promise.reject(e.statusCode + ' ' + e.response.body); // TODO: throw unknown errors but reject well known errors?
    })
    .catch(function(e) {
      console.error('vend.js - An unexpected error occurred: ', e);
      throw e; // TODO: throw unknown errors but reject well known errors?
    });
};

/**
 * If tokenService already has a domainPrefix set because the API consumer passed in a full URL
 * instead of a substitutable one ... then the replace acts as a no-op.
 *
 * @param tokenService
 * @param domain_prefix
 * @returns {*|XML|string|void}
 */
var getTokenUrl = function(tokenService, domain_prefix) {
  var tokenUrl = tokenService.replace(/\{DOMAIN_PREFIX\}/, domain_prefix);
  log.debug('token Url: '+ tokenUrl);
  return tokenUrl;
};

// the API consumer will get the args and fill in the blanks
// the SDK will pull out the non-empty values and execute the request
var args = {
  products: {
    fetchById: function() {
      return {
        apiId: {
          required: true,
          value: undefined
        }
      };
    },
    fetch: function() {
      return {
        orderBy: {
          required: false,
          key: 'order_by',
          value: undefined // updated_at (default) | id | name
        },
        orderDirection: {
          required: false,
          key: 'order_direction',
          value: undefined // ASC (default) | DESC
          //TODO: setup enumerations in javascript?
        },
        since: {
          required: false,
          key: 'since',
          value: undefined
        },
        active: {
          required: false,
          key: 'active',
          value: undefined // 0 (or no value) : returns only inactive products
                           // 1 (or any other value) : returns only active products
          // TODO: can we embed a transformation here?
          //       API consumer will set true or false or 0 or 1 as the value
          //       but SDK will get the 0 or 1 value based on a transformation
        },
        page: {
          required: false,
          key: 'page',
          value: undefined
        },
        pageSize: {
          required: false,
          key: 'page_size',
          value: undefined
        }/*,
        domainPrefix: {
          required: true,
          value: undefined
        },
        accessToken: {
          required: true,
          value: undefined
        },
        retryCounter: {
          required: true,
          value: undefined
        }*/
      };
    }
  }
};

var fetchProduct  = function(args, connectionInfo, retryCounter) {
  if (!retryCounter) {
    retryCounter = 0;
  } else {
    console.log('retry # ' + retryCounter);
  }

  var path = '/api/products/' + args.apiId.value;
  // this is an undocumented implementation by Vend
  // the response has to be accessed like: result.products[0]
  // which is lame ... TODO: should we unwrap it within the SDK?

  var vendUrl = 'https://' + connectionInfo.domainPrefix + '.vendhq.com' + path;
  console.log('Requesting vend product ' + vendUrl);
  var authString = 'Bearer ' + connectionInfo.accessToken;
  log.debug('GET ' + vendUrl);
  log.debug('Authorization: ' + authString); // TODO: sensitive data ... do not log?

  var options = {
    url: vendUrl,
    headers: {
      'Authorization': authString,
      'Accept': 'application/json'
    }
  };

  return sendRequest(options, args, connectionInfo, fetchProduct, retryCounter);
};

var fetchProducts = function(args, connectionInfo, retryCounter) {
  if (!retryCounter) {
    retryCounter = 0;
  } else {
    console.log('retry # ' + retryCounter);
  }

  var path = '/api/products';
  var vendUrl = 'https://' + connectionInfo.domainPrefix + '.vendhq.com' + path;
  var authString = 'Bearer ' + connectionInfo.accessToken;
  log.debug('GET ' + vendUrl);
  log.debug('Authorization: ' + authString); // TODO: sensitive data ... do not log?

  //var domainPrefix = this.domainPrefix;

  var options = {
    url: vendUrl,
    headers: {
      'Authorization': authString,
      'Accept': 'application/json'
    },
    qs: {
      order_by: args.orderBy.value,
      order_direction: args.orderDirection.value,
      since: args.since.value,
      active: (args.active.value) ? 1 : 0,
      page: args.page.value,
      page_size: args.pageSize.value
    }
  };
  if (args.page.value) {
    log.debug('Requesting product page ' + args.page.value);
  }

  return sendRequest(options, args, connectionInfo, fetchProducts, retryCounter);
};

var createRegisterSale = function(body, connectionInfo, retryCounter) {
  log.debug('inside createRegisterSale()');
  if (!retryCounter) {
    retryCounter = 0;
  } else {
    console.log('retry # ' + retryCounter);
  }

  var path = '/api/register_sales';
  var vendUrl = 'https://' + connectionInfo.domainPrefix + '.vendhq.com' + path;
  var authString = 'Bearer ' + connectionInfo.accessToken;
  log.debug('GET ' + vendUrl);
  log.debug('Authorization: ' + authString); // TODO: sensitive data ... do not log?

  var options = {
    method: 'POST',
    url: vendUrl,
    headers: {
      'Authorization': authString,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  };

  return sendRequest(options, args, connectionInfo, createRegisterSale, retryCounter);
};

var getInitialAccessToken = function(tokenService, clientId, clientSecret, redirectUri, code, domainPrefix, state) {
  // TODO: tweak winston logs to prefix method signature (like breadcrumbs) when logging?
  log.debug('getInitialAccessToken - token_service: ' + tokenService);
  log.debug('getInitialAccessToken - client Id: ' + clientId);
  log.debug('getInitialAccessToken - client Secret: ' + clientSecret);
  log.debug('getInitialAccessToken - redirect Uri: ' +  redirectUri);
  log.debug('getInitialAccessToken - code: ' + code);
  log.debug('getInitialAccessToken - domain_prefix: ' + domainPrefix);
  log.debug('getInitialAccessToken - state: ' + state);

  var tokenUrl = getTokenUrl(tokenService, domainPrefix);

  var options = {
    url: tokenUrl,
    headers: {
      'Accept': 'application/json'
    },
    form:{
      'grant_type': 'authorization_code',
      'client_id': clientId,
      'client_secret': clientSecret,
      'code': code,
      'redirect_uri': redirectUri,
      'state': state
    }
  };
  return request.post(options)
    .then(successHandler)
    .catch(RateLimitingError, function(e) {
      console.log('A RateLimitingError error like "429 Too Many Requests" happened: '
        + e.statusCode + ' ' + e.response.body + '\n'
        + JSON.stringify(e.response.headers,null,2));
    })
    .catch(ClientError, function(e) {
      console.log('A ClientError happened: '
          + e.statusCode + ' ' + e.response.body + '\n'
        /*+ JSON.stringify(e.response.headers,null,2)
         + JSON.stringify(e,null,2)*/
      );
      // TODO: add retry logic
    })
    .catch(function(e) {
      console.error('An unexpected error occurred: ', e);
    });
};

var refreshAccessToken = function(tokenService, clientId, clientSecret, refreshToken, domainPrefix) {
  // TODO: tweak winston logs to prefix method signature (like breadcrumbs) when logging?
  log.debug('refreshAccessToken - token service: ' + tokenService);
  log.debug('refreshAccessToken - client Id: ' + clientId);
  log.debug('refreshAccessToken - client Secret: ' + clientSecret);
  log.debug('refreshAccessToken - refresh token: ' +  refreshToken);
  log.debug('refreshAccessToken - domain prefix: ' + domainPrefix);

  if ( !(tokenService && clientId && clientSecret && refreshToken) ) {
    return Promise.reject('missing required arguments for refreshAccessToken()');
  }

  var tokenUrl = getTokenUrl(tokenService, domainPrefix);

  var options = {
    url: tokenUrl,
    headers: {
      'Accept': 'application/json'
    },
    form:{
      'grant_type': 'refresh_token',
      'client_id': clientId,
      'client_secret': clientSecret,
      'refresh_token': refreshToken
    }
  };
  return request.post(options)
    .then(successHandler)
    .catch(RateLimitingError, function(e) {
      console.log('A RateLimitingError error like "429 Too Many Requests" happened: '
        + e.statusCode + ' ' + e.response.body + '\n'
        + JSON.stringify(e.response.headers,null,2));
    })
    .catch(ClientError, function(e) {
      console.log('A ClientError happened: '
          + e.statusCode + ' ' + e.response.body + '\n'
        /*+ JSON.stringify(e.response.headers,null,2)
         + JSON.stringify(e,null,2)*/
      );
      // TODO: add retry logic
    })
    .catch(function(e) {
      console.error('An unexpected error occurred: ', e);
    });
};

/**
 * @param expiresAt - time unit from Vend is in unix epoch format
 * @returns {*} true if the the token will be considered as expired in 2 mins from now
 */
var hasAccessTokenExpired = function(expiresAt) {
  return (moment.unix(expiresAt).isBefore(moment().add(2, 'minutes')));
};

exports.hasAccessTokenExpired = hasAccessTokenExpired;
exports.getInitialAccessToken = getInitialAccessToken;
exports.refreshAccessToken = refreshAccessToken;

exports.args = args;
exports.products = {
  fetch: fetchProducts,
  fetchById: fetchProduct
};
exports.sales = {
  create: createRegisterSale
};