export class Pet {
  static getObjectId(): number { throw new Error('Must be run inside Hive client'); }
  static getInstanceId(): number { throw new Error('Must be run inside Hive client'); }
  static getBagContainerId(): number { throw new Error('Must be run inside Hive client'); }
  static hasBag(): boolean { throw new Error('Must be run inside Hive client'); }
}
