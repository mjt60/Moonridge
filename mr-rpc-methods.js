var rpc = require('socket.io-rpc');
var _ = require('lodash');
var eventNames = require('./schema-events');
var stringifyQuery = require('./mquery-stringify');

/**
 *
 * @param {Model} model
 * @param {Schema} schema
 * @param {Object} opts
 */
var expose = function (model, schema, opts) {
	var liveQueries = {};
	schema.onAll(function (doc, evName) {   // will be called by schema's event firing
		Object.keys(liveQueries).forEach(function (LQString) {
			var LQ = liveQueries[LQString];
			var currQueried = LQ.docs;
			var cQindex = currQueried.indexOf(doc);

			var callListeners = function () {
				var i = LQ.listeners.length;
				while(i--) {
					LQ.listeners[i](doc, evName, LQString);
				}
			};
			if (evName === 'remove' && cQindex !== -1) {

				callListeners();
				currQueried.splice(cQindex, 1);

			} else {
				model.findOne(LQ.query).where('_id').equals(doc._id).select('_id')
					.exec(function(err, id) {
						if (!err && id) {
							if (evName === 'create') {
								currQueried.push(doc);
								callListeners();
							}
							if (evName === 'update') {
								if (cQindex === -1) {
									currQueried.push(doc);
								}
								callListeners();
							}
						} else {
							if (evName === 'update' && cQindex !== -1) {
								currQueried.splice(cQindex, 1);
								callListeners();
							}
						}
					}
				);
			}
		});

	});

	var notifySubscriber = function (clientPubMethod) {
		return function (doc, evName) {   // will be called by schema's event firing
			clientPubMethod(doc, evName);
		}

    };

    var modelName = model.modelName;
    function makeFindQueries(qBase, limit, skip, populate, lean) {
        if (lean === undefined) {
            lean = false;
        }
        var query;
        if (populate) {
            query = model.find(qBase).populate(populate).limit(limit).skip(skip).lean(lean);
        } else {
            query = model.find(qBase).limit(limit).skip(skip).lean(lean);
        }
        return query;
    }

    function unsubscribe(id, event) {  //accepts same args as findFn
        var res = schema.off(id, event);
        if (res) {
            delete this.socket.mrEventIds[event];
        }
        return res;
    }

    /**
     * @param {Socket} socket
     */
    function unsubscribeAll(socket) {
        var soc = socket || this.socket;
        var mrEventIds = soc.mrEventIds;
        for (var eN in mrEventIds) {
            unsubscribe(mrEventIds[eN], eN);
        }
    }

    function subscribe(evName) {
        if (evName) {
            var socket = this.socket;
            if (!socket.mrEventIds) {
                socket.mrEventIds = {};
                socket.on('disconnect', function () {
                    unsubscribeAll(socket);
                });
            }
            var existing = this.socket.mrEventIds;
            if (existing && existing[evName]) {
                // event already subscribed, we don't want to support more than 1 remote listener so we unregister the old one
                unsubscribe(existing[evName], evName);
            }

            var def = when.defer();

            rpc.loadClientChannel(socket, 'MR-' + modelName, function (socket, clFns) {
                
                var evId = schema.on(evName, notifySubscriber(clFns.pub, socket));

                socket.mrEventIds[evName] = evId;
                def.resolve(evId);

            });
            return def.promise;
        } else {
            throw new Error('event must be specified when subscribing to it');
        }

    }

    function subscribeAll(query) {
        var evIds = {};
        eventNames.forEach(function (name) {
            evIds[name] = subscribe(name, query);
        });
        return evIds;
    }

	var channel = {
		find: function (qBase, limit, skip, populate, lean) {
            var q = makeFindQueries.apply(model, arguments);
            return q.exec();
        },
		//unsubscribe
		unsub: unsubscribe,
		unsubAll: unsubscribeAll,
        /**
         *
         * @param qBase object to be used as a param for find() method
         * @param {Number} limit
         * @param {Number} skip
         * @param {Boolean} populate
         * @param lean
         * @returns {Promise} from mongoose query, resolves with an array of documents
         */
        liveQuery: function (qBase, limit, skip, populate, lean) {
            var query = makeFindQueries.apply(model, arguments);
            subscribeAll(query);
			var socket = this.socket;
			var qKey = stringifyQuery(query);
			var LQ = liveQueries[qKey];
			if (LQ) {
				rpc.loadClientChannel(socket, 'MR-' + modelName, function (socket, clFns) {
					if (socket.registeredLQs.indexOf(LQ) !== -1) {
						return 'MR_ERR_1';	//already listening for that query
					}
					LQ.listeners.push({method: clFns.pub, socket: socket});
					socket.registeredLQs.push(LQ);

				});

				return LQ.docs;
			}
			return query.exec().then(function (LQdocs) {
				if (!liveQueries[qKey]) {
					LQ = {docs: [], listeners: [], query: query};	//TODO refactor into a LiveQuery class
					liveQueries[qKey] = LQ;
				}

				rpc.loadClientChannel(socket, 'MR-' + modelName, function (socket, clFns) {
					LQ.listeners.push({method: clFns.pub, socket: socket});
					socket.registeredLQs.push(LQ);
				});

                var i = LQdocs.length;
                while(i--)
                {
					liveQueries[qKey].docs[i] = LQdocs[i];
                }
                return LQdocs;
            });
        },
		//TODO have a method to stop liveQuery
		//subscribe
		sub: subscribe,
		subAll: subscribeAll,
		populate: model.populate
	};

	if (opts.readOnly !== true) {
		_.extend(channel, {
			create: function (newDoc) {
				return model.create(newDoc);
//				var def = when.defer();
//				var lang = new model(newDoc);
//				lang.save(function (err, savedDoc) {
//					if (err) {
//						console.error("Document " + newDoc.toJSON() + " failed to save, error: " + err);
//						def.reject(err);
//					} else {
//						console.log("Following document was succesfully saved:" + savedDoc);
//						def.resolve(savedDoc);
//					}
//				});
//				return def.promise;
			},
			remove: function (id) {
				var def = when.defer();
				model.findById(id, function (err, doc) {
					if (doc) {
						doc.remove(function (err) {
							if (err) {
								def.reject(err);
							}
							def.resolve();
						});
					} else {
						def.reject(new Error('no document with _id: ' + id));
					}
				});
				return def.promise;
			},
			update: function (toUpdate) {
				var def = when.defer();

				var id = toUpdate._id;
				delete toUpdate._id;
				model.findById(id, function (err, doc) {
					if (doc) {
						_.extend(doc, toUpdate);
						doc.save(function (err) {
							if (err) {
								def.reject(err);
							}
							def.resolve();
						});
					}
				});
				return def.promise;
			}
		});
	}
    rpc.expose('MR-' + modelName, channel, opts.authFn)
};

module.exports = expose;


