suite('Reclaiming task', function() {
  var assert = require('assert');
  var co = require('co');
  var waitForEvent = require('../../lib/wait_for_event');
  var settings = require('../settings');
  var cmd = require('./helper/cmd');

  var DockerWorker = require('../dockerworker');
  var TestWorker = require('../testworker');
  var taskcluster = require('taskcluster-client');
  var expires = require('./helper/expires')

  // Ensure we don't leave behind our test configurations.
  teardown(settings.cleanup);

  var worker;
  setup(co(function * () {
    settings.configure({
      task: {
        // just use crazy high reclaim divisor... This will result in way to
        // frequent reclaims but allow us to easily test that it reclaims at
        // least once...
        reclaimDivisor: 1000,
        dequeueCount: 15
      }
    });

    worker = new TestWorker(DockerWorker);
    yield worker.launch();
  }));

  teardown(co(function* () {
    yield worker.terminate();
  }));

  test('wait for reclaim', co(function* () {
    var reclaims = [];
    worker.on('reclaimed task', function(value) {
      reclaims.push(value);
    });

    var result = yield worker.postToQueue({
      payload: {
        image: 'taskcluster/test-ubuntu',
        command: cmd(
          'sleep 10'
        ),
        maxRunTime: 60 * 60,
        features: {
          localLiveLog: false
        }
      }
    });
    assert.ok(reclaims.length > 1, 'issued more than one reclaim');

    assert.ok(
      new Date(reclaims[0].takenUntil) <
      new Date(reclaims[reclaims.length - 1].takenUntil),
      'Last reclaim occurs after the first reclaim'
    );

    assert.equal(result.run.state, 'completed', 'task should be successful');
    assert.equal(result.run.reasonResolved, 'completed', 'task should be successful');
  }));

  test('task canceled when reclaiming past deadline', async () => {
    let deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + 20);

    let results = await Promise.all([
      // Ensure that a cancel event is emitted rather than "abort"
      waitForEvent(worker, 'cancel task'),
      waitForEvent(worker, 'error reclaiming task'),
      worker.postToQueue({
        deadline: deadline,
        payload: {
          image: 'taskcluster/test-ubuntu',
          command: cmd(
            'sleep 30'
          ),
          maxRunTime: 3 * 60
        }
      })
    ]);

    assert.ok(
      !results[2].log,
      'Log file was present when there should not have been one'
    );
  });

  test('test taskcluster-proxy credentials update', async function() {
    let payload = {
      storageType: 'reference',
      expires: expires().toJSON(),
      contentType: 'text/html',
      url: 'https://mozilla.com'
    };

    let updated = false;
    worker.on('Credentials updated', function() {
      updated = true;
    });

    let result = await worker.postToQueue({
      scopes: ['queue:create-artifact:custom'],
      payload: {
        image: 'centos:latest',
        features: { taskclusterProxy: true },
        artifacts: {},
        command: cmd(
          'curl --retry 5 -X POST ' +
          '-H "Content-Type: application/json" ' +
          '--data \'' + JSON.stringify(payload) + '\' ' +
          'taskcluster/queue/v1/task/$TASK_ID/runs/$RUN_ID/artifacts/custom'
        ),
        maxRunTime: 5 * 60
      }
    });

    assert.equal(result.run.state, 'completed', 'task should be successful');
    assert.equal(result.run.reasonResolved, 'completed', 'task should be successful');
    assert.ok(updated);
  });
});

