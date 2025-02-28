'use strict';

var _ = require('./lodash');
var assert = require('assert');
var Stream = require('stream');
var Promise = require('rsvp').Promise;
var autoId = require('firebase-auto-ids');
var DocumentSnapshot = require('./firestore-document-snapshot');
var QuerySnapshot = require('./firestore-query-snapshot');
var Queue = require('./queue').Queue;
var utils = require('./utils');
var validate = require('./validators');

function MockFirestoreQuery(path, data, parent, name) {
  this.errs = {};
  this.path = path || 'Mock://';
  this.id = parent ? name : extractName(path);
  this.flushDelay = parent ? parent.flushDelay : false;
  this.queue = parent ? parent.queue : new Queue();
  this.parent = parent || null;
  this.firestore = parent ? parent.firestore : null;
  this.children = {};
  this.orderedProperties = [];
  this.orderedDirections = [];
  this.limited = 0;
  this.buildStartFinder = function () { return function () { return true; }; };
  this._setData(data);
}

MockFirestoreQuery.prototype.flush = function (delay) {
  this.queue.flush(delay);
  return this;
};

MockFirestoreQuery.prototype.autoFlush = function (delay) {
  if (_.isUndefined(delay)) {
    delay = true;
  }
  if (this.flushDelay !== delay) {
    this.flushDelay = delay;
    _.forEach(this.children, function (child) {
      child.autoFlush(delay);
    });
    if (this.parent) {
      this.parent.autoFlush(delay);
    }
  }
  return this;
};

MockFirestoreQuery.prototype.getFlushQueue = function () {
  return this.queue.getEvents();
};

MockFirestoreQuery.prototype._setData = function (data) {
  this.data = utils.cleanFirestoreData(_.cloneDeep(data) || null);
};

MockFirestoreQuery.prototype._getData = function () {
  return _.cloneDeep(this.data);
};

MockFirestoreQuery.prototype.toString = function () {
  return this.path;
};

MockFirestoreQuery.prototype.get = function () {
  var err = this._nextErr('get');
  var self = this;
  return new Promise(function (resolve, reject) {
    self._defer('get', _.toArray(arguments), function () {
      var results = {};
      var limit = 0;
      var atStart = false;
      var atEnd = false;
      var startFinder = this.buildStartFinder();

      var inRange = function(data, key) {
        if (atEnd) {
          return false;
        } else if (atStart) {
          return true;
        } else {
          atStart = startFinder(data, key);
          return atStart;
        }
      };

      if (err === null) {
        if (_.size(self.data) !== 0) {
          if (self.orderedProperties.length === 0) {
            _.forEach(self.data, function(data, key) {
              if (inRange(data, key) && (self.limited <= 0 || limit < self.limited)) {
                results[key] = _.cloneDeep(data);
                limit++;
              }
            });
          } else {
            var queryable = [];
            _.forEach(self.data, function(data, key) {
              queryable.push({
                data: data,
                key: key
              });
            });

            queryable = _.orderBy(queryable, _.map(self.orderedProperties, function(p) { return 'data.' + p; }), self.orderedDirections);

            queryable.forEach(function(q) {
              if (inRange(q.data, q.key) && (self.limited <= 0 || limit < self.limited)) {
                results[q.key] = _.cloneDeep(q.data);
                limit++;
              }
            });
          }

          resolve(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id), results));
        } else {
          resolve(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id)));
        }
      } else {
        reject(err);
      }
    });
  });
};

MockFirestoreQuery.prototype.stream = function () {
  var stream = new Stream.Transform({
    objectMode: true,
    transform: function (chunk, encoding, done) {
      this.push(chunk);
      done();
    }
  });

  this.get().then(function (snapshots) {
    snapshots.forEach(function (snapshot) {
      stream.write(snapshot);
    });
    stream.end();
  });

  return stream;
};

MockFirestoreQuery.prototype.where = function (property, operator, value) {
  var query = this.clone();

  // check if unsupported operator
  if (operator !== '==' && operator !== 'array-contains') {
    console.warn('Using unsupported where() operator for firebase-mock, returning entire dataset');
  } else {
    if (_.size(this.data) !== 0) {
      var results = {};
      _.forEach(this.data, function(data, key) {
        switch (operator) {
          case '==':
            if (_.isEqual(_.get(data, property), value)) {
              results[key] = _.cloneDeep(data);
            }
            break;
          case 'array-contains':
            if (_.includes(_.get(data, property), value)) {
              results[key] = _.cloneDeep(data);
            }
            break;
          default:
            results[key] = _.cloneDeep(data);
            break;
        }
      });
      query._setData(results);
    } else {
      query._setData(null);
    }
  }

  return query;
};

MockFirestoreQuery.prototype.orderBy = function (property, direction) {
  var query = this.clone();

  query.orderedProperties.push(property);
  query.orderedDirections.push(direction || 'asc');

  return query;
};

MockFirestoreQuery.prototype.limit = function (limit) {
  var query = this.clone();
  query.limited = limit;
  return query;
};

MockFirestoreQuery.prototype.startAfter = function (doc) {
  if (!(doc instanceof DocumentSnapshot)) {
    console.warn('Using unsupported startAfter() parameter for firebase-mock, returning entire dataset');
    return this;
  }

  if (this.orderedProperties.length === 0) {
    throw new Error('Query must be ordered to paginate');
  }

  var query = this.clone();

  query.buildStartFinder = function () {
    var next = false;

    return function (data, key) {
      if (next) {
        return true;
      } else {
        next = key === doc.ref.id;
        return false;
      }
    };
  };

  return query;
};

MockFirestoreQuery.prototype.clone = function () {
  var query = new MockFirestoreQuery(this.path, this._getData(), this.parent, this.id);

  query.orderedProperties = Array.from(this.orderedProperties);
  query.orderedDirections = Array.from(this.orderedDirections);
  query.limited = this.limited;
  query.buildStartFinder = this.buildStartFinder;

  return query;
};

MockFirestoreQuery.prototype._defer = function (sourceMethod, sourceArgs, callback) {
  this.queue.push({
    fn: callback,
    context: this,
    sourceData: {
      ref: this,
      method: sourceMethod,
      args: sourceArgs
    }
  });
  if (this.flushDelay !== false) {
    this.flush(this.flushDelay);
  }
};

MockFirestoreQuery.prototype._nextErr = function (type) {
  var err = this.errs[type];
  delete this.errs[type];
  return err || null;
};

function extractName(path) {
  return ((path || '').match(/\/([^.$\[\]#\/]+)$/) || [null, null])[1];
}

module.exports = MockFirestoreQuery;
