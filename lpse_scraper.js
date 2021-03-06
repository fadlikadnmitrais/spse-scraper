/**
 * Ini merupakan aplikasi untuk melakukan scrapping pada halaman daftar paket dan status masing-masing paket
 * di website LPSE, menggunakan phantomjs. Digunakannya phantomjs, karena pada daftar paket tersebut, isinya
 * merupakan hasil render oleh javascript, sehingga dibutuhkan pembacaan dari hasil generatenya menggunakan
 * perangkat kusus, tidak bisa langsung menggunakan fungsi di php. 
 * Terhadap versi SPSE yang di test adalah SPSE v4.3u20191009.
 * 
 * Hasil dari proses ini adalah adanya file database sebagaimana yang di set pada bagian dbPath, berupa JSON
 * file untuk dibaca kembali oleh tool pembacaan isi pengumuman.
 * 
 * Jalankan dengan perintah dari shell:
 * $ phantomjs lpse_scraper.js
 * 
 * @author Yan F (friskantoni@gmail.com)
 */
// url dituju
var config = require('./config'),
    url = config.scraper.urlDaftarLelang,
    // jumlah halaman dibaca
    pagecnt = 0,
    // maksimal halaman,masukkan nilai 0 untuk mengabaikan halaman, pada skenario ini sistem melakukan pembacaan
    // hingga tombol next pada pembagian halaman data tidak dapat di klik.
    maxpagecnt = config.scraper.maxPageCnt,
    // waitfor module
    waiter = require('./waitfor'),
    // md5
    theHash = require('./md5'),
    jsonutil = require('./jsonutil'),
    jsondbPath = config.scraper.dbPath,
    performaStart = performance.now(),
    // terdapat bug, sehingga pada beberapa kesempatan pembacaan data di halaman, data yang terbaca tidak
    // tersimpan semua. Namun ini bisa dilakukan ulang dengan cara melakukan pembacaan ulang. Hal ini 
    // kemungkinan adanya memory yang terlalu besar digunakan oleh phantomjs, sehingga proses penginputan
    // ke data tidak terlaksana dengan baik. Jadi, menjalankan ulang akan menambahkan data kembali, yang
    // belum masuk akan dimasukkan. Satu yang pasti, lakukan perbandingan total data yang dimasukkan dengan
    // data yang ada di tampilan SPSE.
    previousDataCount = 0, 
    diRunLagi = false 

/**
 * lakukan pengambilan isi datanya.
 */
function scrapePage()
{
    pagecnt = pagecnt + 1
    waiter.waitFor(
        function() {
            // mulai proses pembacaan dan melakukan evaluasi saat halaman sudah terload
            return page.evaluate(function (currentpage) {
                var pagination = $('div#tbllelang_paginate ul.pagination')
                return (
                    $(pagination).is(':visible') && 
                    parseInt($(pagination).find('li.active a').text().trim()) == currentpage
                    )
            }, pagecnt)
        },
        function() {
            stopLoop = false // apa looping diteruskan?
            if(maxpagecnt > 0) { // diputuskan utk membatasi halaman?
                if(pagecnt > maxpagecnt) { // halaman saat ini > max?
                    stopLoop = true
                }
            }
            if (!stopLoop) {
                console.log("Scrapping page: " + pagecnt)
                processingThePage(page, pagecnt)
                if (isNextExist(page)) { // ada kelihatan tombol halaman utk next?
                    clickNext(page) // click next nya!
                    scrapePage() // recursive function
                } else {
                    stopLoop = true
                }
            }
            if( stopLoop ) {
                storeOurDb()
                phantom.exit()
            }
        }
    )
}

/**
 * Check apakah tombol untuk klik next page, tidak di disabled? Kalau di disabled artinya
 * sudah tidak ada lagi halaman yang bisa di load
 * @param {page} page 
 */
function isNextExist(page)
{
    return page.evaluate(function() {
        return !$("li#tbllelang_next").hasClass('disabled')
    })
}

/**
 * click link ke halaman berikutnya
 * @param {page} page 
 */
function clickNext(page)
{
    page.evaluate(function() {
        $('li#tbllelang_next a[aria-controls="tbllelang"][aria-label="Next"]').click()
    })
}

/**
 * Proses halaman yang sedang aktif saat itu!
 * @param {page} page 
 * @param {int} currentPage 
 */
function processingThePage(page, currentPage)
{
    var tableContent = page.evaluate(function() {
        var data = [], 
            count = 0
        // looping pada masing-masing baris di table lelang
        $('table#tbllelang tr').each(function(index, el) {
            var id = $(el).find("td:first").text(), // ambil id
                contentObj = $(el).find('td:nth-child(2)'), // ambil content object
                link = $(contentObj).find('p:first a'),
                linkPengumuman = $(link).attr('href'), // dapatkan link pengumuman
                namaPaket = $(link).html(),
                versiSpse = $(link).next().text(),
                content = contentObj.html(), // isinya dalam html
                schedule = $(el).find('td:nth-child(4)').html(), // dan jadwal aktif
                tentangTender = $(contentObj).find('p:nth-child(2)').text(), // tentang tender
                tentangTenderA = tentangTender.split("-")


            if (content !== undefined) {
                count = count + 1
                data.push({
                    'idTender': id,
                    'namaPaket': namaPaket,
                    'versiSpse': versiSpse,
                    'linkPengumuman': linkPengumuman,
                    'content': content + '<p>' + schedule + '</p>',
                    'jadwal': schedule,
                    'jenis': tentangTenderA[0].trim(),
                    'tahun_anggaran': tentangTenderA[1].trim(),
                    'metode': tentangTenderA[2].trim(),
                    'pelaksanaan': tentangTenderA[3].trim(),
                })
            }
        })

        // console.log("Sum pada evaluate: " + count)
        // di phantomjs terdapat masalah bila kembalian adalah langsung array
        // maka convert ke string dengan format JSON
        return JSON.stringify(data);
    })
    // ambil datanya
    var result = JSON.parse(tableContent),
        resultLength = result.length,
        tryCnt = 0, // berapa kali percobaan dilakukan untuk membaca ulang dan untuk menambahkan lagi
        harapDijalankanKembali = false // harap dijalankan lagi?

    // console.log("Mendapatkan data untuk di proses setelah evaluate : " + resultLength)
    // console.log("Jumlah data tersimpan sebelum hasil evaluate ditambahkan: " +  jsonutil.getLength())

    do {
        var harusnyaAdaPenambahan = 0 // apakah semestinya ada penambahan? dan berapa jumlah penambahan?

        // ada kemungkinan terjadi memory leak? Maka ulangi untuk melakukan pembacaan ulang data yang dikembalikan
        // looping berdasarkan data tersebut
        for (var i = 0; i < resultLength; i++) {
            var content = result[i]['content'],
                md5nya = theHash.md5(content),
                idDicari = result[i]['idTender'] + '_' + md5nya,
                currDate = Date.now() // get timestamps, so it easier to sort!

            // console.log("Ingin dimasukkan: " + idDicari)
            if (jsonutil.isAlreadyInserted(idDicari)) {
                continue
            } else {
                // check apakah ada idTender yang sama sudah dimasukkan?
                var idTenderFound = jsonutil.findValueInField(result[i].idTender, 'idTender')
                if(idTenderFound !== false) {
                    // terdapat idTender yang sudah pernah dimasukkan, jadi ini adalah data yang baru
                    // ada perubahan pada status / jadwal tender. Lakukan segera perubahan dengan 
                    // menghapus data yang ada dan masukkan data barunya kembali!
                    // console.log("Tender dengan id: " + result[i].idTender + " mendapat update, data diperbaharui!")
                    jsonutil.deleteDataAtIndex(idTenderFound)
                } else {
                    // harus ada penambahan hanya terjadi bila ada data baru, tidak melakukan update terhadap 
                    // data yang ada.
                    // console.log("Tender dengan id: " + result[i].idTender + " harusnya ditambahkan!")
                    harusnyaAdaPenambahan = harusnyaAdaPenambahan + 1
                }
                // console.log("New/Update file: " + idDicari)
                result[i]['id'] = idDicari
                result[i]['waktu_check'] = currDate
                result[i]['visited'] = 0
                jsonutil.push(result[i])
            }
        }

        if( harusnyaAdaPenambahan > 0 ) { // bila memang harus ada penambahan?
            currentDataCount = jsonutil.getLength()
            if (previousDataCount == 0) {
                previousDataCount = currentDataCount
            } else {
                if (previousDataCount == currentDataCount) { // jumlah data sebelumnya sama & semestinya ada penambahan
                    diRunLagi = true // set global
                    harapDijalankanKembali = true
                    console.log("Percobaan ke: " + (tryCnt + 1) + " Halaman : " + currentPage)
                    console.log("Ada data tidak dapat ditambahkan ke data utama: " + tableContent)
                } else {
                    harapDijalankanKembali = false
                    previousDataCount = currentDataCount
                }
            }

            tryCnt = tryCnt + 1
        }
        // console.log("Saat ini ditambahkan: " + jsonutil.getLength())
    } while ( tryCnt < 2 && harapDijalankanKembali )
    if( tryCnt > 2 ) {
        console.log("Ada permasalahan data tidak mau ditambahkan!")
        phantom.exit()
    }
}

function initOurDb()
{
    console.log("DB init ...")
    jsonutil.setPath(jsondbPath)
    jsonutil.initAndLoad()
    // tambahkan index untuk pengolahan idTender
    jsonutil.addIndex('idTender')
}

function storeOurDb()
{
    var performaEnd = performance.now()
    console.log("Diselesaikan dalam waktu: " + (performaEnd - performaStart) + " ms")
    console.log("Items dimasukkan: " + jsonutil.getLength())
    jsonutil.saveData()
    console.log("DB stored")
    if(diRunLagi) {
        console.log("Nampaknya terdapat beberapa bagian belum tuntas, silahkan lakukan eksekusi lagi!")
    }
}

// mulai untuk membuat objek webpage punya phantomjs
var page = require('webpage').create()

// akses URL
page.open(url, function(status) {
    if (status == 'success') {
        // lakukan recursive
        initOurDb()
        scrapePage()
    } else {
        console.log("Tidak dapat mengakses url yang dikehendaki")
    }
})