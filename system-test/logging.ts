/*!
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as assert from 'assert';
const {BigQuery} = require('@google-cloud/bigquery');
import * as extend from 'extend';
import * as is from 'is';
import * as nock from 'nock';
const {PubSub} = require('@google-cloud/pubsub');
import {Storage} from '@google-cloud/storage';
import * as uuid from 'uuid';
import {Logging} from '../src';
import {ConfigInterface} from '../src/sink';


// block all attempts to chat with the metadata server (kokoro runs on GCE)
nock('http://metadata.google.internal')
    .get(() => true)
    .replyWithError({code: 'ENOTFOUND'})
    .persist();

describe('Logging', () => {
  let PROJECT_ID: string;
  const TESTS_PREFIX = 'gcloud-logging-test';
  const WRITE_CONSISTENCY_DELAY_MS = 10000;

  const bigQuery = new BigQuery();
  const pubsub = new PubSub();
  const storage = new Storage();
  const logging = new Logging();

  // Create the possible destinations for sinks that we will create.
  const bucket = storage.bucket(generateName());
  const dataset = bigQuery.dataset(generateName().replace(/-/g, '_'));
  const topic = pubsub.topic(generateName());

  before(async () => {
    await Promise.all([
      bucket.create(), dataset.create(), topic.create(),
      logging.auth.getProjectId().then(projectId => {
        PROJECT_ID = projectId;
      })
    ]);
  });

  after(async () => {
    await Promise.all(
        [deleteBuckets(), deleteDatasets(), deleteTopics(), deleteSinks()]);

    async function deleteBuckets() {
      const [buckets] = await storage.getBuckets({
        prefix: TESTS_PREFIX,
      });
      return Promise.all(buckets.map(async bucket => {
        await bucket.deleteFiles();
        await bucket.delete();
      }));
    }

    async function deleteDatasets() {
      return getAndDelete(bigQuery.getDatasets.bind(bigQuery));
    }

    async function deleteTopics() {
      return getAndDelete(pubsub.getTopics.bind(pubsub));
    }

    async function deleteSinks() {
      return getAndDelete(logging.getSinks.bind(logging));
    }

    async function getAndDelete(method: Function) {
      const [objects] = await method();
      return Promise.all(
          objects
              .filter(
                  (o: {name: string, id: string}) =>
                      (o.name || o.id).indexOf(TESTS_PREFIX) === 0)
              .map((o: {delete: Function}) => o.delete()));
    }
  });

  describe('sinks', () => {
    it('should create a sink with a Bucket destination', async () => {
      const sink = logging.sink(generateName());
      // tslint:disable-next-line no-any
      const [_, apiResponse] = await (sink as any).create({
        destination: bucket,
      });
      const destination = 'storage.googleapis.com/' + bucket.name;
      assert.strictEqual(apiResponse.destination, destination);
    });

    it('should create a sink with a Dataset destination', async () => {
      const sink = logging.sink(generateName());
      // tslint:disable-next-line no-any
      const [_, apiResponse] = await (sink as any)
                                   .create(
                                       {
                                         destination: dataset,
                                       },
                                   );

      const destination = `bigquery.googleapis.com/datasets/${dataset.id}`;

      // The projectId may have been replaced depending on how the system
      // tests are being run, so let's not care about that.
      apiResponse.destination =
          apiResponse.destination.replace(/projects\/[^/]*\//, '');
      assert.strictEqual(apiResponse.destination, destination);
    });

    it('should create a sink with a Topic destination', async () => {
      const sink = logging.sink(generateName());
      // tslint:disable-next-line no-any
      const [_, apiResponse] = await (sink as any).create({destination: topic});
      const destination = 'pubsub.googleapis.com/' + topic.name;

      // The projectId may have been replaced depending on how the system
      // tests are being run, so let's not care about that.
      assert.strictEqual(
          apiResponse.destination.replace(/projects\/[^/]*\//, ''),
          destination.replace(/projects\/[^/]*\//, ''));
    });

    describe('metadata', () => {
      const sink = logging.sink(generateName());
      const FILTER = 'severity = ALERT';

      before(async () => {
        await sink.create({destination: topic} as ConfigInterface);
      });

      it('should set metadata', async () => {
        const metadata = {filter: FILTER};
        // tslint:disable-next-line no-any
        const [apiResponse] = await (sink as any).setMetadata(metadata);
        assert.strictEqual(apiResponse.filter, FILTER);
      });

      it('should set a filter', async () => {
        // tslint:disable-next-line no-any
        const [apiResponse] = await (sink as any).setFilter(FILTER);
        assert.strictEqual(apiResponse.filter, FILTER);
      });
    });

    describe('listing sinks', () => {
      const sink = logging.sink(generateName());

      before(async () => {
        await sink.create({destination: topic} as ConfigInterface);
      });

      it('should list sinks', async () => {
        const [sinks] = await logging.getSinks();
        assert(sinks.length > 0);
      });

      it('should list sinks as a stream', done => {
        const logstream = logging.getSinksStream({pageSize: 1})
                              .on('error', done)
                              .once('data', () => {
                                // tslint:disable-next-line no-any
                                (logstream as any).end();
                                done();
                              });
      });

      it('should get metadata', done => {
        logging.getSinksStream({pageSize: 1})
            .on('error', done)
            .once('data', (sink: {getMetadata: Function}) => {
              sink.getMetadata((err: Error, metadata: {}) => {
                assert.ifError(err);
                assert.strictEqual(is.object(metadata), true);
                done();
              });
            });
      });
    });
  });

  describe('logs', () => {
    const log = logging.log(`system-test-logs-${uuid.v4()}`);

    const logEntries = [
      // string data
      log.entry('log entry 1'),

      // object data
      log.entry({delegate: 'my_username'}),

      // various data types
      log.entry({
        nonValue: null,
        boolValue: true,
        arrayValue: [1, 2, 3],
      }),

      // nested object data
      log.entry({
        nested: {
          delegate: 'my_username',
        },
      }),
    ];

    const options = {
      resource: {
        type: 'gce_instance',
        labels: {
          zone: 'global',
          instance_id: '3',
        },
      },
    };

    after(done => log.delete(done));

    it('should list log entries', async () => {
      const [entries] = await logging.getEntries({
        autoPaginate: false,
        pageSize: 1,
      });
      assert.strictEqual(entries.length, 1);
    });

    it('should list log entries as a stream', done => {
      const logstream = logging
                            .getEntriesStream({
                              autoPaginate: false,
                              pageSize: 1,
                            })
                            .on('error', done)
                            .once('data', () => logstream.end())
                            .on('end', done);
    });

    describe('log-specific entries', () => {
      before(done => {
        log.write(logEntries, options, done);
      });

      it('should list log entries', async () => {
        const [entries] = await log.getEntries({
          autoPaginate: false,
          pageSize: 1,
        });
        assert.strictEqual(entries.length, 1);
      });

      it('should list log entries as a stream', done => {
        const logstream = log.getEntriesStream({
                               autoPaginate: false,
                               pageSize: 1,
                             })
                              .on('error', done)
                              .once('data', () => {
                                logstream.end();
                                done();
                              });
      });
    });

    it('should write a single entry to a log', done => {
      log.write(logEntries[0], options, done);
    });

    it('should write multiple entries to a log', async () => {
      await log.write(logEntries, options);
      await new Promise(r => setTimeout(r, WRITE_CONSISTENCY_DELAY_MS));
      const [entries] = await log.getEntries({
        autoPaginate: false,
        pageSize: logEntries.length,
      });
      assert.deepStrictEqual(entries.map((x: {data: {}}) => x.data).reverse(), [
        'log entry 1',
        {delegate: 'my_username'},
        {
          nonValue: null,
          boolValue: true,
          arrayValue: [1, 2, 3],
        },
        {
          nested: {
            delegate: 'my_username',
          },
        },
      ]);
    });

    it('should preserve order of entries', done => {
      const entry1 = log.entry('1');

      setTimeout(() => {
        const entry2 = log.entry('2');
        const entry3 = log.entry({timestamp: entry2.metadata.timestamp}, '3');

        // Re-arrange to confirm the timestamp is sent and honored.
        log.write([entry2, entry3, entry1], options, (err: Error) => {
          assert.ifError(err);

          setTimeout(() => {
            log.getEntries(
                {
                  autoPaginate: false,
                  pageSize: 3,
                },
                (err: Error, entries: []) => {
                  assert.ifError(err);
                  assert.deepStrictEqual(
                      entries.map((x: {data: {}}) => x.data), [
                        '3',
                        '2',
                        '1',
                      ]);
                  done();
                });
          }, WRITE_CONSISTENCY_DELAY_MS * 4);
        });
      }, 1000);
    });

    it('should preserve order for sequential write calls', done => {
      const messages = ['1', '2', '3', '4', '5'];

      messages.forEach(message => {
        log.write(log.entry(message));
      });

      setTimeout(() => {
        log.getEntries(
            {
              autoPaginate: false,
              pageSize: messages.length,
            },
            (err: Error, entries: []) => {
              assert.ifError(err);
              assert.deepStrictEqual(
                  entries.reverse().map((x: {data: {}}) => x.data), messages);
              done();
            });
      }, WRITE_CONSISTENCY_DELAY_MS * 4);
    });

    it('should write an entry with primitive values', done => {
      const logEntry = log.entry({
        when: new Date(),
        matchUser: /username: (.+)/,
        matchUserError: new Error('No user found.'),
        shouldNotBeSaved: undefined,
      });

      log.write(logEntry, options, (err: Error) => {
        assert.ifError(err);

        setTimeout(() => {
          log.getEntries(
              {
                autoPaginate: false,
                pageSize: 1,
              },
              (err: Error, entries: [{data: {}}]) => {
                assert.ifError(err);

                const entry: {data: {}} = entries[0];

                assert.deepStrictEqual(entry.data, {
                  when: logEntry.data.when.toString(),
                  matchUser: logEntry.data.matchUser.toString(),
                  matchUserError: logEntry.data.matchUserError.toString(),
                });

                done();
              });
        }, WRITE_CONSISTENCY_DELAY_MS);
      });
    });

    it('should write a log with metadata', done => {
      const metadata = extend({}, options, {
        severity: 'DEBUG',
      });

      const data = {
        embeddedData: true,
      };

      const logEntry = log.entry(metadata, data);

      log.write(logEntry, undefined, (err: Error) => {
        assert.ifError(err);

        setTimeout(() => {
          log.getEntries(
              {
                autoPaginate: false,
                pageSize: 1,
              },
              (err: Error,
               entries: [{metadata: {severity: string}, data: {}}]) => {
                assert.ifError(err);

                const entry: {metadata: {severity: string}, data: {}} =
                    entries[0];

                assert.strictEqual(entry.metadata.severity, metadata.severity);
                assert.deepStrictEqual(entry.data, data);

                done();
              });
        }, WRITE_CONSISTENCY_DELAY_MS);
      });
    });

    it('should set the default resource', done => {
      const text = 'entry-text';
      const entry = log.entry(text);

      log.write(entry, undefined, (err: Error) => {
        assert.ifError(err);

        setTimeout(() => {
          log.getEntries(
              {
                autoPaginate: false,
                pageSize: 1,
              },
              (err: Error, entries: [{metadata: {resource: {}}, data: {}}]) => {
                assert.ifError(err);

                const entry = entries[0];

                assert.strictEqual(entry.data, text);
                assert.deepStrictEqual(entry.metadata.resource, {
                  type: 'global',
                  labels: {
                    project_id: PROJECT_ID,
                  },
                });

                done();
              });
        }, WRITE_CONSISTENCY_DELAY_MS);
      });
    });

    it('should write a log with camelcase resource label keys', done => {
      log.write(
          logEntries, {
            resource: {
              type: 'gce_instance',
              labels: {
                zone: 'global',
                instanceId: '3',
              },
            },
          },
          done);
    });

    it('should write to a log with alert helper', done => {
      log.alert(logEntries, options, done);
    });

    it('should write to a log with critical helper', done => {
      log.critical(logEntries, options, done);
    });

    it('should write to a log with debug helper', done => {
      log.debug(logEntries, options, done);
    });

    it('should write to a log with emergency helper', done => {
      log.emergency(logEntries, options, done);
    });

    it('should write to a log with error helper', done => {
      log.error(logEntries, options, done);
    });

    it('should write to a log with info helper', done => {
      log.info(logEntries, options, done);
    });

    it('should write to a log with notice helper', done => {
      log.notice(logEntries, options, done);
    });

    it('should write to a log with warning helper', done => {
      log.warning(logEntries, options, done);
    });
  });

  function generateName() {
    return TESTS_PREFIX + uuid.v1();
  }
});
