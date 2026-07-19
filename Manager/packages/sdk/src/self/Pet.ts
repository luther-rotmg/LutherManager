export class Pet {
  static getObjectId(): number { throw new Error('Must be run inside LutherManager client'); }
  static getInstanceId(): number { throw new Error('Must be run inside LutherManager client'); }
  static getBagContainerId(): number { throw new Error('Must be run inside LutherManager client'); }
  static hasBag(): boolean { throw new Error('Must be run inside LutherManager client'); }
}
