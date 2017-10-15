/*
  Copyright 2017 Google Inc. All Rights Reserved.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
      http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import constants from './constants';
import FilterTransform from './filters/filter-transform';
import {IListRecord, imageDB} from './image-db';
import {canvasToBlob} from './promise-helpers';

enum ImageState {
  NotLoaded, // Haven't looked for it in IndexedDB yet
  Loaded,    // Version in memory is the same as in IDB
  Changed,   // Version in memory is different from IDB
  OutOfDate, // Version in memory does not reflect the original and/or transform
}

export default class ImageRecord {
  static async fromDatabase(id: number) {
    const data = await imageDB.retrieveRecord(id);
    return ImageRecord.fromListRecord(data);
  }

  static fromListRecord(data: IListRecord) {
    const result = new ImageRecord();

    result.id = data.id;
    result.guid = data.guid;

    result.originalState = ImageState.NotLoaded;
    result.editedState = ImageState.NotLoaded;
    result.thumbnailState = ImageState.NotLoaded;

    result.originalId = data.originalId;
    result.editedId = data.editedId;
    result.thumbnailId = data.thumbnailId;

    result.transform = FilterTransform.from(data.transform);

    result.localImageChanges = data.localImageChanges;
    result.localFilterChanges = data.localFilterChanges;
    result.lastSyncVersion = data.lastSyncVersion;

    return result;
  }

  static async getAll(): Promise<ImageRecord[]> {
    const records = await imageDB.all();
    const result: ImageRecord[] = [];

    for (const record of records) {
      result.push(ImageRecord.fromListRecord(record));
    }

    return result;
  }

  id: number | null;
  guid: string;

  originalState: ImageState;
  editedState: ImageState;
  thumbnailState: ImageState;

  originalId: number | null;
  editedId: number | null;
  thumbnailId: number | null;

  localImageChanges: boolean;
  localFilterChanges: boolean;
  lastSyncVersion: number;

  private $transform: FilterTransform | null;

  private originalCache: Blob | null;
  private editedCache: Blob | null;
  private thumbnailCache: Blob | null;

  constructor() {
    this.id = null;
    this.guid = '';

    this.originalState = ImageState.Changed;
    this.editedState = ImageState.Changed;
    this.thumbnailState = ImageState.Changed;

    this.originalId = null;
    this.editedId = null;
    this.thumbnailId = null;

    this.$transform = null;

    this.localImageChanges = true;
    this.localFilterChanges = true;
    this.lastSyncVersion = -1;

    this.originalCache = null;
    this.editedCache = null;
    this.thumbnailCache = null;
  }

  get transform(): FilterTransform | null {
    return this.$transform;
  }

  set transform(value: FilterTransform | null) {
    this.$transform = value;
    this.editedState = ImageState.OutOfDate;
    this.thumbnailState = ImageState.OutOfDate;
    this.localFilterChanges = true;
  }

  async getOriginal(): Promise<Blob | null> {
    if (this.originalId && this.originalState === ImageState.NotLoaded) {
      this.originalCache = await imageDB.retrieveMedia(this.originalId);
      this.originalState = ImageState.Loaded;
    }

    return this.originalCache;
  }

  async getEdited(): Promise<Blob | null> {
    if (this.editedId && this.editedState === ImageState.NotLoaded) {
      this.editedCache = await imageDB.retrieveMedia(this.editedId);
      this.editedState = ImageState.Loaded;
    }
    if (!this.editedId || this.editedState === ImageState.OutOfDate) {
      this.editedCache = await this.drawFiltered();
      this.editedState = ImageState.Changed;
    }
    return this.editedCache;
  }

  async getThumbnail(): Promise<Blob | null> {
    if (this.thumbnailId && this.thumbnailState === ImageState.NotLoaded) {
      this.thumbnailCache = await imageDB.retrieveMedia(this.thumbnailId);
      this.thumbnailState = ImageState.Loaded;
    }
    if (!this.thumbnailId || this.thumbnailState === ImageState.OutOfDate) {
      this.thumbnailCache = await this.drawFiltered(200);
      this.thumbnailState = ImageState.Changed;
    }
    return this.thumbnailCache;
  }

  setOriginal(media: Blob) {
    this.originalCache = media;
    this.originalState = ImageState.Changed;
    this.editedState = ImageState.OutOfDate;
    this.thumbnailState = ImageState.OutOfDate;
    this.localImageChanges = true;
  }

  async delete() {
    if (!this.id) {
      return;
    }
    const mediaIds: number[] = [];
    if (this.originalId) {
      mediaIds.push(this.originalId);
    }
    if (this.editedId) {
      mediaIds.push(this.editedId);
    }
    if (this.thumbnailId) {
      mediaIds.push(this.thumbnailId);
    }
    return imageDB.deleteRecord(this.id, mediaIds);
  }

  async drawFiltered(height?: number): Promise<Blob | null> {
    const original = await this.getOriginal();
    const result: Promise<Blob | null> = new Promise((resolve, reject) => {
      if (original) {
        const source = document.createElement('img');
        source.onload = () => {
          if (this.transform) {
            const canvas = document.createElement('canvas');
            URL.revokeObjectURL(source.src);
            this.transform.apply(source, canvas, height);
            resolve(canvasToBlob(canvas, constants.IMAGE_TYPE));
          } else {
            resolve(null);
          }
        };
        source.onerror = reject;
        source.src = URL.createObjectURL(original);
      }
    });

    return result;
  }

  async save(): Promise<void> {
    if (this.originalState === ImageState.Changed && this.originalCache !== null) {
      this.originalId = await imageDB.storeMedia(this.originalCache, this.originalId || undefined);
    }

    if (this.editedState === ImageState.OutOfDate) {
      this.editedCache = await this.drawFiltered();
      this.editedState = ImageState.Changed;
    }

    if (this.editedState === ImageState.Changed && this.editedCache !== null) {
      this.editedId = await imageDB.storeMedia(this.editedCache, this.editedId || undefined);
    }

    if (this.thumbnailState === ImageState.OutOfDate) {
      this.thumbnailCache = await this.drawFiltered(200);
      this.thumbnailState = ImageState.Changed;
    }

    if (this.thumbnailState === ImageState.Changed && this.thumbnailCache !== null) {
      this.thumbnailId = await imageDB.storeMedia(this.thumbnailCache, this.thumbnailId || undefined);
    }

    let transformRecord: INumDict = {};

    if (this.$transform) {
      transformRecord = {...this.$transform};
    }

    const id = await imageDB.storeRecord({
      editedId: this.editedId,
      guid: this.guid,
      id: this.id,
      lastSyncVersion: this.lastSyncVersion,
      localFilterChanges: this.localFilterChanges,
      localImageChanges: this.localImageChanges,
      originalId: this.originalId,
      thumbnailId: this.thumbnailId,
      transform: transformRecord,
    });
    this.id = id;
  }
}
