create table message_vjur
(
    id              serial                     not null primary key,
    hash            text                       not null,
    title           text                       not null,
    body            text                       not null,
    create_time     timestamp(0) default now() not null,
    title_ru        text                       not null,
    body_ru         text                       not null,
    telegram_msg_id integer
);

create unique index message_vjur_hash_uindex
    on message_vjur (hash);

create table ena_message
(
    id              serial                     not null primary key,
    hash            text,
    create_time     timestamp(0) default now() not null,
    body            text                       not null,
    telegram_msg_id integer,
    message_group   text
);

create unique index message_ena_hash_uindex
    on ena_message (hash);

create table ena_emergency
(
    id            serial                     not null primary key,
    started_time  timestamp(0)               not null,
    finished_time timestamp(0),
    created_time  timestamp(0) default now() not null,
    title         text                       not null
);

create unique index ena_emergency_started_time_title_uindex
    on ena_emergency (started_time, title);
