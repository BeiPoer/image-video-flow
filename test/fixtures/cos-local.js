import COS from 'cos-nodejs-sdk-v5';

// Test-only preload: exercise the real SDK against a local COS protocol server.
if (!/^127\.0\.0\.1:\d+$/.test(process.env.COS_TEST_DOMAIN || '')) throw new Error('Invalid mock COS endpoint');
for (const name of ['getBucketLifecycle', 'putBucketLifecycle', 'headObject', 'putObject', 'getObjectUrl']) {
  const original = COS.prototype[name];
  COS.prototype[name] = function (...args) {
    this.options.Domain = process.env.COS_TEST_DOMAIN;
    this.options.Protocol = 'http:';
    this.options.MaxRetries = 0;
    return original.apply(this, args);
  };
}
